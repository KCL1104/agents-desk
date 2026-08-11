//! The attempt flow, end to end through the core.
//!
//! Driven by a stub agent rather than a real one: what is being checked here
//! is what AgentDesk does — which worktree it opens, what it puts on the
//! command line, what it records, and what it gives back afterwards — none of
//! which needs a model to answer. `tests/prompt_injection.rs` covers the part
//! that genuinely needed measuring against the real `claude`.
//!
//!     cargo test --test attempts -- --nocapture

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "../src/config.rs"]
mod config;
#[path = "../src/core.rs"]
mod core;
#[path = "../src/host.rs"]
mod host;
#[path = "../src/hooks.rs"]
mod hooks;
#[path = "../src/i18n.rs"]
mod i18n;
#[path = "../src/prompt.rs"]
mod prompt;
#[path = "../src/pty.rs"]
mod pty;
#[path = "../src/shell_env.rs"]
mod shell_env;
#[path = "../src/store.rs"]
mod store;
#[path = "../src/worktree.rs"]
mod worktree;

use crate::core::{Core, Status, UiSink};
use crate::shell_env::ShellEnv;
use crate::store::{Lifecycle, Outcome, PermissionMode};

#[derive(Default)]
struct Events(Mutex<Vec<(String, serde_json::Value)>>);

impl UiSink for Events {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        self.0.lock().unwrap().push((event.to_string(), payload));
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git must be installed");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Everything one test needs: a repository, a stub agent on the PATH, and a
/// core wired to both.
struct Harness {
    root: PathBuf,
    repo: PathBuf,
    core: Arc<Core>,
    rt: tokio::runtime::Runtime,
    /// Kept so a test can stand a second core over the same directories —
    /// which is the only way to exercise what a restart sees.
    env: ShellEnv,
}

/// A stand-in for an agent CLI. Records the working directory and every
/// argument it was given, then stays alive reading its terminal — so the
/// session looks the way a real one does, and what a follow-up fed into the
/// PTY can be read back out.
///
/// NUL-separated, because the argument under test is a multi-line prompt and
/// a line-per-argument log cannot tell one argument containing newlines from
/// several arguments — which is exactly the distinction these tests exist to
/// make. One file per launch, named by pid, so reopening a session leaves the
/// first launch's record intact beside the second's. The stdin capture is
/// named `stdin.<session>.<pid>` so `launches` never mistakes it for a launch
/// record.
///
/// `--version` answers immediately, the way the real CLI does, because the
/// core probes it once at startup — a stub that hung there would slow every
/// test's boot by the probe's timeout.
const STUB: &str = r#"#!/bin/bash
if [ "$1" = "--version" ]; then echo "2.1.226 (Claude Code)"; exit 0; fi
printf '%s\0' "$PWD" "$@" > "$AGENTDESK_STUB_LOG/${AGENTDESK_SESSION_ID:-unknown}.$$"
# 宣告它所替身的那個 CLI 真的會宣告的模式:Claude Code 開啟 bracketed
# paste(DECSET 2004),而 `bracketed_followup` 只送給量測過會開它的 CLI。
# 這一行之前 stub 是個沉默的位元組水槽,而任何會照 2004 決定要不要轉發
# 標記的傳輸層(例如 tmux)看到的就是「這支程式沒要」。
printf '\033[?2004h'
exec cat > "$AGENTDESK_STUB_LOG/stdin.${AGENTDESK_SESSION_ID:-unknown}.$$"
"#;

/// A stand-in for a Claude Code release from before session names existed.
/// What matters is what it is NOT handed: `--name` would stop it starting.
const OLD_STUB: &str = r#"#!/bin/bash
if [ "$1" = "--version" ]; then echo "2.0.14 (Claude Code)"; exit 0; fi
printf '%s\0' "$PWD" "$@" > "$AGENTDESK_STUB_LOG/${AGENTDESK_SESSION_ID:-unknown}.$$"
exec cat > "$AGENTDESK_STUB_LOG/stdin.${AGENTDESK_SESSION_ID:-unknown}.$$"
"#;

impl Harness {
    fn new(name: &str) -> Self {
        Self::with_claude_stub(name, STUB)
    }

    /// The same harness with a different `claude` on the PATH — how the
    /// version gate is exercised against a CLI from another era.
    fn with_claude_stub(name: &str, claude_stub: &str) -> Self {
        let root = std::env::temp_dir().join(format!("agentdesk-att-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);

        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main", "-q"]);
        git(&repo, &["config", "user.email", "t@agentdesk.test"]);
        git(&repo, &["config", "user.name", "AgentDesk Test"]);
        std::fs::write(repo.join("app.txt"), "one\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "first"]);

        // A PATH with our stubs first and the real tools behind them, so git
        // still resolves while `claude` and `codex` are ours.
        let bin = root.join("bin");
        let logs = root.join("logs");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&logs).unwrap();
        for (agent, stub) in [("claude", claude_stub), ("codex", STUB)] {
            let p = bin.join(agent);
            std::fs::write(&p, stub).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }

        // A stand-in for wsl.exe: the "distro" shares this machine's
        // filesystem, and its login environment is pinned to the harness's
        // own — stubs first on PATH, HOME at the harness root — so the whole
        // WSL route (probe, git, spawn, env crossing) runs for real against
        // local processes. What it cannot vouch for is the real wsl.exe's
        // quirks; that is what a Windows machine validates.
        let fake_wsl = format!(
            r#"#!/bin/bash
export PATH="{bin}:/usr/bin:/bin"
export HOME="{home}"
export AGENTDESK_STUB_LOG="{logs}"
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--shell-type) shift 2 ;;
    --cd) cd "$2" || exit 1; shift 2 ;;
    -e|--) shift; break ;;
    *) shift ;;
  esac
done
exec "$@"
"#,
            bin = bin.display(),
            home = root.display(),
            logs = logs.display(),
        );
        let p = bin.join("wsl.exe");
        std::fs::write(&p, fake_wsl).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let mut vars: HashMap<String, String> = HashMap::new();
        vars.insert(
            "PATH".into(),
            format!("{}:/usr/bin:/bin:/usr/local/bin", bin.display()),
        );
        vars.insert("AGENTDESK_STUB_LOG".into(), logs.to_string_lossy().into());
        vars.insert("HOME".into(), root.to_string_lossy().into());
        let env = ShellEnv {
            vars,
            shell: "/bin/bash".into(),
            resolved: true,
        };

        let rt = tokio::runtime::Runtime::new().unwrap();
        let core = rt
            .block_on(Core::start_with(
                env.clone(),
                Arc::new(Events::default()) as Arc<dyn UiSink>,
                root.join("agentdesk.db"),
                root.join("data"),
                root.join("worktrees"),
            ))
            .expect("core");

        Self {
            root,
            repo,
            core,
            rt,
            env,
        }
    }

    fn card(&self, title: &str, prompt: &str) -> String {
        self.core
            .create_task(
                title.into(),
                prompt.into(),
                self.repo.to_string_lossy().into(),
                "main".into(),
            )
            .expect("create task")
    }

    /// Start an attempt now, through the same call the button makes. The
    /// default limit leaves room, so this never lands in the queue.
    fn start(&self, task_id: &str, agent: &str) -> crate::core::OpenedAttempt {
        self.core
            .start_attempt(task_id, agent.into(), None, PermissionMode::Normal, 100, 30)
            .expect("start attempt")
            .attempt
            .expect("there was a free slot")
    }

    /// Every time the stub agent was started for this session, oldest first.
    fn launches(&self, session_id: &str, at_least: usize) -> Vec<Launch> {
        let dir = self.root.join("logs");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let mut found: Vec<(std::time::SystemTime, Launch)> = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    if !name.starts_with(&format!("{session_id}.")) {
                        continue;
                    }
                    let Ok(bytes) = std::fs::read(e.path()) else { continue };
                    let mut parts: Vec<String> = bytes
                        .split(|b| *b == 0)
                        .map(|s| String::from_utf8_lossy(s).into_owned())
                        .collect();
                    // A trailing separator leaves an empty final field.
                    if parts.last().is_some_and(|s| s.is_empty()) {
                        parts.pop();
                    }
                    if parts.is_empty() {
                        continue;
                    }
                    let when = e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH);
                    found.push((
                        when,
                        Launch {
                            cwd: parts.remove(0),
                            args: parts,
                        },
                    ));
                }
            }
            if found.len() >= at_least {
                found.sort_by_key(|(t, _)| *t);
                return found.into_iter().map(|(_, l)| l).collect();
            }
            if Instant::now() > deadline {
                panic!(
                    "expected {at_least} launch(es) of the stub agent for session {session_id}, saw {}",
                    found.len()
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn args_of(&self, session_id: &str) -> Vec<String> {
        self.launches(session_id, 1).pop().unwrap().args
    }

    /// Post a hook report the way Claude Code's own hook runner would.
    fn hook(&self, session_id: &str, state: &str, body: serde_json::Value) {
        use std::io::{Read as _, Write as _};
        let url = self.core.hook_url().expect("hook listener");
        // http://127.0.0.1:PORT/h/TOKEN
        let rest = url.trim_start_matches("http://");
        let (addr, path) = rest.split_once('/').expect("url has a path");
        let body = if body.is_null() { String::new() } else { body.to_string() };
        let mut sock = std::net::TcpStream::connect(addr).expect("connect to the hook listener");
        let req = format!(
            "POST /{path}?state={state} HTTP/1.1\r\nHost: localhost\r\n\
             X-AgentDesk-Session: {session_id}\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(req.as_bytes()).unwrap();
        let mut resp = String::new();
        let _ = sock.read_to_string(&mut resp);
        assert!(resp.starts_with("HTTP/1.1 200"), "hook was not answered: {resp}");
    }

    /// The timeline, once it has at least `at_least` rows. The writer runs on
    /// its own thread, so this is the honest way to read it.
    fn timeline(&self, attempt_id: &str, at_least: usize) -> Vec<crate::store::AttemptEvent> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let rows = self.core.attempt_events(attempt_id).unwrap_or_default();
            if rows.len() >= at_least {
                return rows;
            }
            if Instant::now() > deadline {
                panic!("expected {at_least} timeline rows, saw {}: {rows:?}", rows.len());
            }
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    fn cwd_of(&self, session_id: &str) -> String {
        self.launches(session_id, 1).pop().unwrap().cwd
    }

    /// Give the harness repository an `.agentdesk/config.json`.
    fn config(&self, json: &str) {
        let dir = self.repo.join(".agentdesk");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), json).unwrap();
    }

    /// Whether any launch record exists for this session, without waiting.
    fn launched(&self, session_id: &str) -> bool {
        std::fs::read_dir(self.root.join("logs"))
            .map(|entries| {
                entries.flatten().any(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with(&format!("{session_id}."))
                })
            })
            .unwrap_or(false)
    }

    /// Everything the session's terminal has been fed, once anything has.
    /// The stub's `cat` writes what it reads, so this is the input as the
    /// agent would have received it.
    fn stdin_of(&self, session_id: &str) -> String {
        let dir = self.root.join("logs");
        let prefix = format!("stdin.{session_id}.");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let mut all = String::new();
            if let Ok(entries) = std::fs::read_dir(&dir) {
                let mut files: Vec<_> = entries
                    .flatten()
                    .filter(|e| e.file_name().to_string_lossy().starts_with(&prefix))
                    .collect();
                files.sort_by_key(|e| e.file_name());
                for f in files {
                    if let Ok(s) = std::fs::read_to_string(f.path()) {
                        all.push_str(&s);
                    }
                }
            }
            if !all.is_empty() {
                return all;
            }
            if Instant::now() > deadline {
                panic!("nothing arrived on session {session_id}'s stdin");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// Poll until `done`, for the things another thread makes true.
fn wait_for(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

struct Launch {
    cwd: String,
    args: Vec<String>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.core.shutdown();
        // `shutdown` detaches held sessions rather than ending them — that is
        // the feature, and in production the next start sweeps whatever has
        // no card left. A test is the one case where nothing ever comes back:
        // the sweep only reaches sockets tagged with its own data directory,
        // and the next test has a different one. Left alone, a full run ends
        // with one idle tmux server per session.
        let tag = pty::desk_tag(&self.root.join("data").to_string_lossy());
        for s in self.core.sessions() {
            let sock = pty::hold_socket(&tag, &s.id);
            let _ = std::process::Command::new("tmux")
                .args(["-L", &sock, "kill-server"])
                .output();
            // The server exits but leaves its socket inode; a full run would
            // otherwise strew hundreds of dead files through the tmux dir.
            if let Some(dir) = core::tmux_socket_dir() {
                let _ = std::fs::remove_file(dir.join(&sock));
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The whole of M1 in one pass: a card becomes a worktree, a branch, a
/// running session that was handed the prompt, and a row that remembers all
/// of it.
#[test]
fn opening_an_attempt_puts_an_agent_in_a_worktree_of_its_own() {
    let h = Harness::new("open");
    let _guard = h.rt.enter();
    let task = h.card("修好登入", "登入頁在 Safari 會白畫面");

    let opened = h.start(&task, "claude");

    assert_eq!(opened.branch, "agentdesk/task-".to_string() + &task[..8] + "-1");
    assert!(opened.prompt_sent, "claude's conventions are measured");
    assert!(Path::new(&opened.worktree_path).is_dir());

    // The agent is in the worktree, not in the repository the person works in.
    assert_eq!(
        std::fs::canonicalize(h.cwd_of(&opened.session_id)).unwrap(),
        std::fs::canonicalize(&opened.worktree_path).unwrap()
    );

    // The prompt is the last argument, after every option.
    let args = h.args_of(&opened.session_id);
    assert_eq!(
        args.last().map(String::as_str),
        Some(opened.prompt.as_str()),
        "the prompt was not the final argument: {args:?}"
    );
    assert!(
        !args.iter().any(|a| a == "--continue"),
        "a fresh worktree has no history to continue: {args:?}"
    );
    // And it arrived whole, newlines and all, as one argument.
    assert!(opened.prompt.contains("登入頁在 Safari 會白畫面"));
    assert!(opened.prompt.contains(&opened.branch));

    // The card moved itself onto the board's running column.
    let board = h.core.task_board();
    assert_eq!(board[0].task.lifecycle, Lifecycle::Running);
    assert_eq!(board[0].attempts.len(), 1);
    assert_eq!(
        board[0].attempts[0].session_id.as_deref(),
        Some(opened.session_id.as_str())
    );

    // A brand-new worktree opens on the folder-trust prompt, which no hook
    // can report. If this were `Starting`, the badge would miss the state
    // every attempt begins in.
    let session = h
        .core
        .sessions()
        .into_iter()
        .find(|s| s.id == opened.session_id)
        .unwrap();
    assert_eq!(session.status, Status::AwaitingTrust);
    assert!(session.status.needs_you());

    // What the agent was asked is recorded as sent, not reconstructed later.
    let events = h.core.attempt_events(&opened.attempt_id).unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].kind, "prompt");
    assert_eq!(events[0].detail.as_deref(), Some(opened.prompt.as_str()));
}

#[test]
fn two_attempts_at_one_card_get_a_worktree_each() {
    let h = Harness::new("two");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");

    let a = h.start(&task, "claude");
    let b = h.start(&task, "claude");

    assert_eq!(a.branch, "agentdesk/fix-login-1");
    assert_eq!(b.branch, "agentdesk/fix-login-2");
    assert_ne!(a.worktree_path, b.worktree_path);

    // Both are live, and neither can see the other's files.
    std::fs::write(Path::new(&a.worktree_path).join("only-a.txt"), "a").unwrap();
    assert!(!Path::new(&b.worktree_path).join("only-a.txt").exists());

    let board = h.core.task_board();
    assert_eq!(board[0].attempts.len(), 2);
    // The card is still one card, on the board once.
    assert_eq!(board.len(), 1);
}

/// The step that must not be skipped, and the order it has to happen in.
#[test]
fn finishing_an_attempt_freezes_the_diff_before_taking_the_worktree_back() {
    let h = Harness::new("finish");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    // What the agent did: an edit and a new file.
    std::fs::write(Path::new(&a.worktree_path).join("app.txt"), "fixed\n").unwrap();
    std::fs::write(Path::new(&a.worktree_path).join("new.rs"), "fn main() {}\n").unwrap();

    h.core.finish_attempt(&a.attempt_id, Outcome::Merged).unwrap();

    assert!(
        !Path::new(&a.worktree_path).exists(),
        "the worktree is still on disk; this is how the disk fills up"
    );
    let listed = git(&h.repo, &["worktree", "list"]);
    assert!(!listed.contains(&a.worktree_path), "git still lists it: {listed}");

    // The diff outlived the directory it described.
    let diff = h.core.attempt_diff(&a.attempt_id).unwrap();
    assert!(diff.contains("fixed"), "the edit was lost with the worktree:\n{diff}");
    assert!(diff.contains("new.rs"), "the new file was lost:\n{diff}");

    // The branch stays: it is what a merged attempt was merged from.
    assert!(git(&h.repo, &["branch", "--list", &a.branch]).contains(&a.branch));
}

/// A finished attempt has no worktree, so there is nothing to reopen into.
/// Saying so beats spawning a terminal in a directory that is not there.
#[test]
fn a_finished_attempt_cannot_be_reopened() {
    let h = Harness::new("reopenfin");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");
    h.core.finish_attempt(&a.attempt_id, Outcome::Discarded).unwrap();

    let err = h
        .core
        .reopen_attempt(&a.attempt_id, 100, 30)
        .expect_err("a removed worktree cannot host a session");
    assert!(err.to_string().contains("finished"), "unhelpful: {err}");
}

/// After a restart every attempt is in this state. Reopening continues the
/// agent's own history and must not send the prompt again — a second copy
/// would set it off doing the whole card from the beginning.
#[test]
fn reopening_an_attempt_continues_instead_of_asking_again() {
    let h = Harness::new("reopen");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");
    h.launches(&a.session_id, 1); // let the first launch land

    h.core.close_session(&a.session_id).unwrap();
    let session_id = h.core.reopen_attempt(&a.attempt_id, 100, 30).expect("reopen");

    let second = h.launches(&session_id, 2).pop().unwrap();
    assert!(
        second.args.iter().any(|a| a == "--continue"),
        "reopening did not pass --continue: {:?}",
        second.args
    );
    assert!(
        !second.args.iter().any(|a| a.contains("[AgentDesk")),
        "the prompt was sent a second time; the agent would redo the whole card: {:?}",
        second.args
    );
}

/// Honest degradation: we only measured Claude Code's argument conventions.
/// For anything else the session is still real, and the prompt is built and
/// handed to the person instead of guessed at.
#[test]
fn an_agent_whose_conventions_we_have_not_measured_is_not_sent_a_prompt() {
    let h = Harness::new("codex");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");

    let opened = h.start(&task, "codex");

    assert!(!opened.prompt_sent);
    // Built and available to copy, just not delivered.
    assert!(opened.prompt.contains("make it work"));

    let args = h.args_of(&opened.session_id);
    assert!(
        args.is_empty(),
        "an unmeasured CLI was handed arguments anyway: {args:?}"
    );
    // The worktree is real regardless — this is a working session, not a stub.
    assert!(Path::new(&opened.worktree_path).is_dir());
}

/// The prompt dialog is editable, and what it sends is what gets recorded.
#[test]
fn an_edited_prompt_is_what_gets_sent_and_what_gets_recorded() {
    let h = Harness::new("edited");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "the original request");

    let edited = "我改過的 prompt\n\n第二行".to_string();
    let opened = h
        .core
        .start_attempt(&task, "claude".into(), Some(edited.clone()), PermissionMode::Normal, 100, 30)
        .unwrap()
        .attempt
        .unwrap();

    assert_eq!(opened.prompt, edited);
    assert_eq!(h.args_of(&opened.session_id).last(), Some(&edited));
    let events = h.core.attempt_events(&opened.attempt_id).unwrap();
    assert_eq!(events[0].detail.as_deref(), Some(edited.as_str()));
    assert!(
        !events[0].detail.as_deref().unwrap().contains("the original request"),
        "the timeline shows the template, not what was actually sent"
    );
}

/* -------------------------- queue and finishing ------------------------ */

/// Over the limit, a start waits instead of being refused. The answer to
/// "too many at once" is "later", not "no".
#[test]
fn a_start_over_the_limit_waits_its_turn_and_then_goes_by_itself() {
    let h = Harness::new("queue");
    let _guard = h.rt.enter();
    h.core.set_max_concurrent(1).unwrap();

    let first = h.card("First", "p");
    let second = h.card("Second", "p");

    let a = h
        .core
        .start_attempt(&first, "claude".into(), None, PermissionMode::Normal, 100, 30)
        .unwrap();
    assert!(a.attempt.is_some(), "the first one had room");

    let b = h
        .core
        .start_attempt(&second, "claude".into(), Some("我排隊的 prompt".into()), PermissionMode::Normal, 100, 30)
        .unwrap();
    assert!(b.attempt.is_none(), "the second should not have started");
    assert_eq!(b.queued_at, Some(1));
    assert_eq!(h.core.queue().len(), 1);

    // The board shows where it is waiting.
    let board = h.core.task_board();
    let waiting = board.iter().find(|t| t.task.id == second).unwrap();
    assert_eq!(waiting.queued_at, Some(1));
    assert!(waiting.attempts.is_empty());

    // A slot frees, and the queue moves on its own.
    let session = a.attempt.unwrap().session_id;
    h.core.close_session(&session).unwrap();

    let started = wait_for(Duration::from_secs(10), || {
        h.core
            .task_board()
            .into_iter()
            .find(|t| t.task.id == second)
            .map(|t| !t.attempts.is_empty())
            .unwrap_or(false)
    });
    assert!(started, "the queue never moved after a slot came free");
    assert!(h.core.queue().is_empty());

    // And it sent the prompt that was approved, not a fresh render.
    let attempt = h
        .core
        .task_board()
        .into_iter()
        .find(|t| t.task.id == second)
        .unwrap()
        .attempts[0]
        .attempt
        .clone();
    let events = h.core.attempt_events(&attempt.id).unwrap();
    assert_eq!(events[0].detail.as_deref(), Some("我排隊的 prompt"));
}

/// Raising the limit is a way of saying "go now", so it has to be one.
#[test]
fn raising_the_limit_releases_what_was_waiting() {
    let h = Harness::new("raise");
    let _guard = h.rt.enter();
    h.core.set_max_concurrent(1).unwrap();

    let first = h.card("First", "p");
    let second = h.card("Second", "p");
    h.core.start_attempt(&first, "claude".into(), None, PermissionMode::Normal, 100, 30).unwrap();
    h.core.start_attempt(&second, "claude".into(), None, PermissionMode::Normal, 100, 30).unwrap();
    assert_eq!(h.core.queue().len(), 1);

    h.core.set_max_concurrent(2).unwrap();
    assert!(h.core.queue().is_empty(), "raising the limit left it waiting");
    assert_eq!(h.core.running_attempts(), 2);
}

/// Pressing 開始 again on a card that is already waiting means "these are the
/// settings I want", not "run it twice".
#[test]
fn a_card_can_only_be_in_the_queue_once() {
    let h = Harness::new("once");
    let _guard = h.rt.enter();
    h.core.set_max_concurrent(1).unwrap();

    let first = h.card("First", "p");
    let second = h.card("Second", "p");
    h.core.start_attempt(&first, "claude".into(), None, PermissionMode::Normal, 100, 30).unwrap();
    h.core
        .start_attempt(&second, "claude".into(), Some("first try".into()), PermissionMode::Normal, 100, 30)
        .unwrap();
    h.core
        .start_attempt(&second, "codex".into(), Some("changed my mind".into()), PermissionMode::Normal, 100, 30)
        .unwrap();

    let queue = h.core.queue();
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].agent, "codex");
    assert_eq!(queue[0].prompt, "changed my mind");
}

#[test]
fn a_queued_card_can_be_taken_back_out() {
    let h = Harness::new("cancel");
    let _guard = h.rt.enter();
    h.core.set_max_concurrent(1).unwrap();
    let first = h.card("First", "p");
    let second = h.card("Second", "p");
    h.core.start_attempt(&first, "claude".into(), None, PermissionMode::Normal, 100, 30).unwrap();
    h.core.start_attempt(&second, "claude".into(), None, PermissionMode::Normal, 100, 30).unwrap();

    h.core.cancel_queued(&second).unwrap();
    assert!(h.core.queue().is_empty());
    assert_eq!(
        h.core.task_board().into_iter().find(|t| t.task.id == second).unwrap().queued_at,
        None
    );
}

/// Only attempts count against the limit. An ad-hoc session is something a
/// person opened deliberately and is already looking at.
#[test]
fn ad_hoc_sessions_do_not_use_up_the_limit() {
    let h = Harness::new("adhoclimit");
    let _guard = h.rt.enter();
    h.core.set_max_concurrent(1).unwrap();

    h.core
        .new_session(h.repo.to_string_lossy().into(), "claude".into(), vec![], 100, 30)
        .unwrap();
    let task = h.card("First", "p");
    let r = h.core.start_attempt(&task, "claude".into(), None, PermissionMode::Normal, 100, 30).unwrap();
    assert!(r.attempt.is_some(), "an ad-hoc session took the attempt's slot");
}

/* ------------------------------ merging -------------------------------- */

#[test]
fn merging_folds_the_branch_into_the_base_and_closes_the_attempt_out() {
    let h = Harness::new("merge");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    std::fs::write(Path::new(&a.worktree_path).join("app.txt"), "fixed\n").unwrap();
    git(Path::new(&a.worktree_path), &["add", "-A"]);
    git(Path::new(&a.worktree_path), &["commit", "-qm", "fix it"]);

    h.core.merge_attempt(&a.attempt_id).expect("merge");

    // The work is on the base branch, in the checkout the person works in.
    assert_eq!(
        std::fs::read_to_string(h.repo.join("app.txt")).unwrap(),
        "fixed\n"
    );
    // `--no-ff`, so the attempt stays legible as one piece of work.
    assert!(git(&h.repo, &["log", "--oneline", "--merges", "-1"]).contains("Merge agentdesk/"));

    // And the attempt is closed out: worktree gone, diff kept.
    assert!(!Path::new(&a.worktree_path).exists());
    assert!(h.core.attempt_diff(&a.attempt_id).unwrap().contains("fixed"));
}

/// The prompt asks the agent to commit. When it has not, merging the branch
/// would produce a merge that does not contain the work — and the work is in
/// a directory that is about to be removed.
#[test]
fn merging_refuses_while_the_worktree_still_has_uncommitted_work() {
    let h = Harness::new("dirtywt");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");
    std::fs::write(Path::new(&a.worktree_path).join("app.txt"), "not committed\n").unwrap();

    let err = h
        .core
        .merge_attempt(&a.attempt_id)
        .expect_err("a merge that would drop the work must not happen");
    assert!(err.to_string().contains("沒有 commit"), "unhelpful: {err}");

    // Nothing was given up on the way to finding out.
    assert!(Path::new(&a.worktree_path).exists());
    assert!(h.core.task_board()[0].attempts[0].attempt.outcome.is_none());
}

/// Merging into a checkout that is on another branch would rewrite what the
/// person is in the middle of.
#[test]
fn merging_refuses_when_the_checkout_is_somewhere_else() {
    let h = Harness::new("otherbranch");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");
    std::fs::write(Path::new(&a.worktree_path).join("app.txt"), "fixed\n").unwrap();
    git(Path::new(&a.worktree_path), &["add", "-A"]);
    git(Path::new(&a.worktree_path), &["commit", "-qm", "fix it"]);

    git(&h.repo, &["checkout", "-q", "-b", "something-else"]);
    let err = h
        .core
        .merge_attempt(&a.attempt_id)
        .expect_err("must not merge into whatever happens to be checked out");
    assert!(err.to_string().contains("something-else"), "unhelpful: {err}");
    assert!(Path::new(&a.worktree_path).exists());
}

/// Two agents on one card is a comparison; the merge is what decides it. The
/// attempt that did not land is superseded — its worktree comes back, its
/// diff freezes — rather than left holding a directory forever with nothing
/// left to decide about it.
#[test]
fn merging_one_attempt_supersedes_the_other_still_open_one() {
    let h = Harness::new("supersede");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");
    let b = h.start(&task, "codex");

    // Both worked; only one gets merged.
    std::fs::write(Path::new(&a.worktree_path).join("app.txt"), "a's fix\n").unwrap();
    git(Path::new(&a.worktree_path), &["add", "-A"]);
    git(Path::new(&a.worktree_path), &["commit", "-qm", "fix it"]);
    std::fs::write(Path::new(&b.worktree_path).join("app.txt"), "b's fix\n").unwrap();

    h.core.merge_attempt(&a.attempt_id).expect("merge");

    let board = h.core.task_board();
    let outcomes: Vec<_> = board[0]
        .attempts
        .iter()
        .map(|x| (x.attempt.seq, x.attempt.outcome))
        .collect();
    assert_eq!(
        outcomes,
        vec![(1, Some(Outcome::Merged)), (2, Some(Outcome::Superseded))]
    );

    // The loser's worktree came back, and its evidence did not go with it.
    assert!(!Path::new(&b.worktree_path).exists());
    let frozen = h.core.attempt_diff(&b.attempt_id).unwrap();
    assert!(frozen.contains("b's fix"), "the superseded diff was lost:\n{frozen}");

    // Its branch keeps its number reserved, exactly like any finished attempt.
    assert_eq!(h.core.running_attempts(), 0);
}

#[test]
fn merging_says_so_when_the_attempt_did_nothing() {
    let h = Harness::new("nothing");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    let err = h
        .core
        .merge_attempt(&a.attempt_id)
        .expect_err("an empty branch has nothing to merge");
    assert!(err.to_string().contains("沒有東西可以合併"), "unhelpful: {err}");
}

/* ------------------------------ follow-ups ----------------------------- */

/// The review loop's delivery: feedback composed against the diff goes back
/// into the session's own terminal as ONE pasted message, and onto the
/// timeline as what was actually asked.
#[test]
fn a_followup_reaches_the_terminal_whole_and_lands_on_the_timeline() {
    let h = Harness::new("followup");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");
    h.launches(&a.session_id, 1); // the terminal is up

    let text = "[AgentDesk 檢視回饋]\n1. auth.py:12 還是回 None\n2. 缺一個測試";
    h.core.send_followup(&a.session_id, text).expect("send");

    // The record: the opening prompt, then this, verbatim.
    let rows = h.timeline(&a.attempt_id, 2);
    assert_eq!(rows[1].kind, "prompt");
    assert_eq!(rows[1].detail.as_deref(), Some(text));

    // The delivery: newlines ride inside the bracketed paste, so the message
    // arrives as one message rather than one per line.
    let stdin = h.stdin_of(&a.session_id);
    assert!(stdin.contains("\u{1b}[200~"), "no paste start: {stdin:?}");
    assert!(stdin.contains("\u{1b}[201~"), "no paste end: {stdin:?}");
    assert!(
        stdin.contains("還是回 None\n2. 缺一個測試"),
        "the message's own newlines did not survive: {stdin:?}"
    );
}

/// The same honesty the first prompt has: an unmeasured CLI's input
/// conventions are not guessed at. The text is the person's to paste, and
/// nothing lands on the timeline claiming it was sent.
#[test]
fn a_followup_to_an_unmeasured_cli_is_refused_rather_than_guessed() {
    let h = Harness::new("fucodex");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "codex");
    h.launches(&a.session_id, 1);

    let err = h
        .core
        .send_followup(&a.session_id, "改一下")
        .expect_err("codex's input conventions are not measured");
    assert!(err.to_string().contains("codex"), "unhelpful: {err}");

    std::thread::sleep(Duration::from_millis(200));
    let rows = h.core.attempt_events(&a.attempt_id).unwrap();
    assert_eq!(rows.len(), 1, "a refused send still reached the timeline: {rows:?}");
}

#[test]
fn an_empty_followup_is_not_sent() {
    let h = Harness::new("fuempty");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    assert!(h.core.send_followup(&a.session_id, "  \n").is_err());
}

/* ------------------------------ WSL bridge ----------------------------- */

/// M10a end to end, through a stand-in wsl.exe: a `wsl://` card's worktree is
/// created inside the distro under the distro's own home, the agent launches
/// there with its argv intact and its session identity carried across the
/// boundary, the diff reads back through the host, and closing returns the
/// tree. Everything the app does with WSL, minus the real wsl.exe's quirks.
#[test]
fn a_wsl_repository_runs_its_whole_attempt_inside_the_distro() {
    let h = Harness::new("wsl");
    let _guard = h.rt.enter();

    let repo_url = format!("wsl://TestOS{}", h.repo.display());
    let task = h
        .core
        .create_task("修好登入".into(), "make it work".into(), repo_url, "main".into())
        .expect("a wsl:// repository must be checkable through the doorway");

    let a = h.start(&task, "claude");

    // Stored in the app's path space, so every later reader knows the host…
    assert!(
        a.worktree_path.starts_with("wsl://TestOS/"),
        "{}",
        a.worktree_path
    );
    let inner = a.worktree_path.strip_prefix("wsl://TestOS").unwrap();
    // …and living under the distro's own home, never the app machine's root.
    assert!(
        inner.starts_with(&format!("{}/.agentdesk/worktrees", h.root.display())),
        "the worktree left the distro: {inner}"
    );
    assert!(Path::new(inner).is_dir(), "the worktree was never created");

    // The agent is running inside: right directory, prompt still the last
    // argv entry — and the launch record existing at all proves
    // AGENTDESK_SESSION_ID crossed the boundary, because the stub names its
    // log file after it.
    let launch = h.launches(&a.session_id, 1).pop().unwrap();
    assert_eq!(
        std::fs::canonicalize(&launch.cwd).unwrap(),
        std::fs::canonicalize(inner).unwrap()
    );
    assert_eq!(launch.args.last(), Some(&a.prompt));
    // The distro's claude answered the version probe, so the session still
    // gets its card's name for cross-session messaging.
    assert!(
        launch
            .args
            .windows(2)
            .any(|w| w[0] == "--name" && w[1] == "修好登入 #1"),
        "{:?}",
        launch.args
    );

    // The diff reads through the host, freezes on close, and the tree goes
    // back to the distro.
    std::fs::write(Path::new(inner).join("app.txt"), "fixed\n").unwrap();
    assert!(h.core.attempt_diff(&a.attempt_id).unwrap().contains("fixed"));
    h.core.finish_attempt(&a.attempt_id, Outcome::Discarded).unwrap();
    assert!(!Path::new(inner).exists(), "the worktree outlived its attempt");
    assert!(
        h.core.attempt_diff(&a.attempt_id).unwrap().contains("fixed"),
        "the frozen diff was lost with the worktree"
    );
}

/// A host nobody can reach fails at first contact, in the dialog, with the
/// probe's own words — never as a phantom "no such directory".
#[test]
fn an_unreachable_ssh_host_fails_the_card_with_the_probes_reason() {
    if std::env::var("AGENTDESK_SSH_TEST").is_err() {
        eprintln!("skipping: set AGENTDESK_SSH_TEST=1 to run the ssh tests");
        return;
    }
    let h = Harness::new("sshghost");
    let _guard = h.rt.enter();
    let err = h
        .core
        .create_task(
            "x".into(),
            "y".into(),
            "ssh://agentdesk-no-such-host/home/me/app".into(),
            "main".into(),
        )
        .expect_err("an unreachable host cannot back a card");
    assert!(
        err.to_string().contains("agentdesk-no-such-host"),
        "the error must name the host: {err}"
    );
}

/* ------------------------------- SSH host ------------------------------ */

/// A real sshd on a loopback port, a real ssh steered through a private
/// config by a wrapper on the harness PATH, and this machine standing in for
/// the remote. Everything is real — the login-shell probe, multiplexing, the
/// reverse tunnel, remote plugin provisioning — except the distance.
struct SshFixture {
    sshd: std::process::Child,
    /// The stub agent we wrote onto the remote login PATH, to remove after.
    stub: Option<PathBuf>,
    /// Whether the stub answers to `claude` there (full assertions), or only
    /// to `codex` (mechanics only — a real claude was shadowing the name).
    claude_stubbed: bool,
}

impl SshFixture {
    /// `None` skips the test: no sshd on this machine, or no way to put the
    /// stub on the remote login PATH without touching anything real.
    fn start(h: &Harness) -> Option<Self> {
        let sshd_bin = Path::new("/usr/sbin/sshd");
        if !sshd_bin.exists() {
            eprintln!("skipping: /usr/sbin/sshd is not installed");
            return None;
        }
        let dir = h.root.join("sshd");
        std::fs::create_dir_all(&dir).unwrap();
        let keygen = |path: &Path| {
            std::process::Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(path)
                .status()
                .map(|s| s.success())
                .unwrap_or(false)
        };
        if !keygen(&dir.join("hostkey")) || !keygen(&dir.join("userkey")) {
            eprintln!("skipping: ssh-keygen unavailable");
            return None;
        }
        std::fs::copy(dir.join("userkey.pub"), dir.join("authorized_keys")).unwrap();

        let port = std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let user = String::from_utf8_lossy(
            &std::process::Command::new("id").arg("-un").output().unwrap().stdout,
        )
        .trim()
        .to_string();

        std::fs::write(
            dir.join("sshd_config"),
            format!(
                "Port {port}\nListenAddress 127.0.0.1\nHostKey {hk}\nPidFile {pid}\n\
                 AuthorizedKeysFile {ak}\nStrictModes no\nUsePAM no\n\
                 PasswordAuthentication no\nPermitRootLogin prohibit-password\n\
                 AllowTcpForwarding yes\n",
                hk = dir.join("hostkey").display(),
                pid = dir.join("sshd.pid").display(),
                ak = dir.join("authorized_keys").display(),
            ),
        )
        .unwrap();

        let sshd = std::process::Command::new(sshd_bin)
            .args(["-f"])
            .arg(dir.join("sshd_config"))
            .args(["-D", "-e"])
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let up = wait_for(Duration::from_secs(5), || {
            std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
        });
        if !up {
            eprintln!("skipping: sshd never came up");
            return None;
        }

        // The client side: a private config, reached through a wrapper `ssh`
        // that the harness PATH puts in front of the real one — the same
        // trick as the stand-in wsl.exe, except everything behind it is real.
        std::fs::write(
            dir.join("ssh_config"),
            format!(
                "Host agentdesk-test\n  HostName 127.0.0.1\n  Port {port}\n  User {user}\n\
                 \x20 IdentityFile {ik}\n  IdentitiesOnly yes\n  StrictHostKeyChecking no\n\
                 \x20 UserKnownHostsFile /dev/null\n  LogLevel ERROR\n",
                ik = dir.join("userkey").display(),
            ),
        )
        .unwrap();
        let wrapper = h.root.join("bin").join("ssh");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/bash\nexec /usr/bin/ssh -F {} \"$@\"\n",
                dir.join("ssh_config").display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        // A stub agent on the REMOTE login PATH — which is this machine's
        // real one, so nothing real may be touched: only a free name in a
        // writable standard directory, removed afterwards. `claude` when the
        // name is free, `codex` when a real claude is shadowing it.
        let logs = h.root.join("logs");
        let remote_stub = |name: &str| -> Option<PathBuf> {
            for cand in ["/usr/local/bin", "/usr/bin"] {
                let path = Path::new(cand).join(name);
                if path.exists() {
                    continue; // never clobber anything real
                }
                let body = format!(
                    "#!/bin/bash\nif [ \"$1\" = \"--version\" ]; then echo \"2.1.226 (Claude Code)\"; exit 0; fi\n\
                     printf '%s\\0' \"$PWD\" \"$@\" > \"{logs}/${{AGENTDESK_SESSION_ID:-unknown}}.$$\"\n\
                     exec cat > \"{logs}/stdin.${{AGENTDESK_SESSION_ID:-unknown}}.$$\"\n",
                    logs = logs.display()
                );
                if std::fs::write(&path, &body).is_err() {
                    continue; // not writable here; try the next
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
                }
                // Exact match through the remote login shell, or it does not
                // count: a real claude earlier on the PATH must never be the
                // thing a test launches.
                let seen = std::process::Command::new(&wrapper)
                    .args(["agentdesk-test", &format!("$SHELL -lc 'command -v {name}'")])
                    .output()
                    .ok();
                let found = seen
                    .map(|o| String::from_utf8_lossy(&o.stdout).trim() == path.to_string_lossy())
                    .unwrap_or(false);
                if found {
                    return Some(path);
                }
                let _ = std::fs::remove_file(&path);
            }
            None
        };

        let (stub, claude_stubbed) = match remote_stub("claude") {
            Some(p) => (Some(p), true),
            None => (remote_stub("codex"), false),
        };
        if stub.is_none() {
            eprintln!("skipping: no writable directory on the remote login PATH for the stub");
            sshd_cleanup(&mut Some(sshd));
            return None;
        }

        Some(Self {
            sshd,
            stub,
            claude_stubbed,
        })
    }
}

fn sshd_cleanup(child: &mut Option<std::process::Child>) {
    if let Some(mut c) = child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

impl Drop for SshFixture {
    fn drop(&mut self) {
        let _ = self.sshd.kill();
        let _ = self.sshd.wait();
        if let Some(p) = &self.stub {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// M10b end to end against a real sshd: the card checks out, the worktree
/// opens in the remote home, the agent launches through a forced-tty ssh with
/// its argv armoured and its identity across, the diff reads back, the hook
/// plugin is provisioned remotely with a tunnel URL, and closing returns the
/// tree. Gated: set AGENTDESK_SSH_TEST=1 (CI does).
#[test]
fn an_ssh_repository_runs_its_whole_attempt_on_the_remote() {
    if std::env::var("AGENTDESK_SSH_TEST").is_err() {
        eprintln!("skipping: set AGENTDESK_SSH_TEST=1 to run the ssh tests");
        return;
    }
    let h = Harness::new("sshfull");
    let _guard = h.rt.enter();
    let Some(fx) = SshFixture::start(&h) else {
        return;
    };

    let repo_url = format!("ssh://agentdesk-test{}", h.repo.display());
    let task = h
        .core
        .create_task("修好登入".into(), "make it work".into(), repo_url, "main".into())
        .expect("an ssh:// repository must be checkable over the wire");

    let agent = if fx.claude_stubbed { "claude" } else { "codex" };
    let a = h.start(&task, agent);

    // Remote paths, remote home.
    assert!(a.worktree_path.starts_with("ssh://agentdesk-test/"), "{}", a.worktree_path);
    let inner = a.worktree_path.strip_prefix("ssh://agentdesk-test").unwrap();
    let home = dirs::home_dir().unwrap();
    assert!(
        inner.starts_with(&format!("{}/.agentdesk/worktrees", home.display())),
        "the worktree left the remote home: {inner}"
    );
    assert!(Path::new(inner).is_dir());

    // The agent runs there: right cwd, identity across the wire (the launch
    // record's very name is the session id), and for a claude stub the
    // prompt arrived whole as the last word of an armoured command line.
    let launch = h.launches(&a.session_id, 1).pop().unwrap();
    assert_eq!(
        std::fs::canonicalize(&launch.cwd).unwrap(),
        std::fs::canonicalize(inner).unwrap()
    );
    if fx.claude_stubbed {
        assert_eq!(launch.args.last(), Some(&a.prompt));
        assert!(a.prompt.contains('\n'), "the prompt under test must be multi-line");
        assert!(
            launch.args.windows(2).any(|w| w[0] == "--name" && w[1] == "修好登入 #1"),
            "{:?}",
            launch.args
        );
    }

    // The hook plugin was provisioned into the remote home, its URL pointing
    // back through the reverse tunnel — never at the app's own listener
    // address, which means nothing on the remote.
    let hooks_file = home.join(".agentdesk/plugin/hooks/hooks.json");
    let hooks_text = std::fs::read_to_string(&hooks_file).expect("remote plugin missing");
    assert!(hooks_text.contains("http://127.0.0.1:"), "{hooks_text}");

    // Diff over the wire; close returns the tree and keeps the evidence.
    std::fs::write(Path::new(inner).join("app.txt"), "fixed over ssh\n").unwrap();
    assert!(h.core.attempt_diff(&a.attempt_id).unwrap().contains("fixed over ssh"));
    h.core.finish_attempt(&a.attempt_id, Outcome::Discarded).unwrap();
    assert!(!Path::new(inner).exists());
    assert!(h.core.attempt_diff(&a.attempt_id).unwrap().contains("fixed over ssh"));

    // Tidy the remote worktree directory this repo was given.
    if let Some(parent) = Path::new(inner).parent() {
        let _ = std::fs::remove_dir_all(parent);
    }
}

/* ----------------------- cross-session messaging ----------------------- */

/// Claude Code's cross-session messaging addresses a session by name, and
/// left to itself the CLI derives one from the directory — a worktree slug
/// with a counter. AgentDesk knows the card, so the session answers to what
/// the board calls it, and one card's agent can message another's by the
/// title a person would actually say.
#[test]
fn a_claude_session_is_named_after_its_card_for_messaging() {
    let h = Harness::new("msgname");
    let _guard = h.rt.enter();
    let task = h.card("修好登入", "make it work");

    let a = h.start(&task, "claude");
    let args = h.args_of(&a.session_id);
    let named = args
        .windows(2)
        .any(|w| w[0] == "--name" && w[1] == "修好登入 #1");
    assert!(named, "the session did not get its card's name: {args:?}");
    assert_eq!(args.last(), Some(&a.prompt), "the prompt must stay last");

    // An ad-hoc session answers to its directory's name, same as its title.
    let id = h
        .core
        .new_session(h.repo.to_string_lossy().into(), "claude".into(), vec![], 100, 30)
        .unwrap();
    let args = h.args_of(&id);
    assert!(
        args.windows(2).any(|w| w[0] == "--name" && w[1] == "repo"),
        "{args:?}"
    );
}

/// The gate that keeps this safe: a claude from before session names existed
/// is never handed `--name` — the flag would stop it starting at all.
#[test]
fn an_older_claude_is_not_handed_the_name_flag() {
    let h = Harness::with_claude_stub("msgold", OLD_STUB);
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");

    let a = h.start(&task, "claude");
    let args = h.args_of(&a.session_id);
    assert!(
        !args.iter().any(|x| x == "--name"),
        "an unmeasured flag was handed to an older CLI: {args:?}"
    );
    // Everything else about the session is untouched by the gate.
    assert_eq!(args.last(), Some(&a.prompt));
    assert!(args.iter().any(|x| x == "--plugin-dir"));
}

/* ------------------------------ profiles ------------------------------- */

/// A profile is a name for "this CLI, with these flags, every time". Picking
/// it launches the real agent with the standing arguments first — and the
/// prompt still last — while the attempt records the CLI underneath, so
/// delivery, hooks and resume all behave by what actually ran.
#[test]
fn a_profile_launches_its_agent_with_its_standing_arguments() {
    let h = Harness::new("profile");
    let _guard = h.rt.enter();
    h.core
        .set_profiles(vec![crate::store::Profile {
            name: "opus 版".into(),
            agent: "claude".into(),
            args: vec!["--model".into(), "opus".into()],
        }])
        .unwrap();
    let task = h.card("Fix login", "make it work");

    let opened = h
        .core
        .start_attempt(&task, "opus 版".into(), None, PermissionMode::Normal, 100, 30)
        .unwrap()
        .attempt
        .unwrap();

    let args = h.args_of(&opened.session_id);
    let pair = args.windows(2).any(|w| w[0] == "--model" && w[1] == "opus");
    assert!(pair, "the profile's arguments never arrived: {args:?}");
    assert_eq!(args.last(), Some(&opened.prompt), "the prompt must stay last");
    assert!(
        args.iter().any(|a| a == "--plugin-dir"),
        "a claude profile still reports status: {args:?}"
    );
    assert!(opened.prompt_sent, "a claude profile still sends the prompt");

    // The record names the CLI, not the nickname.
    assert_eq!(h.core.task_board()[0].attempts[0].attempt.agent, "claude");
}

#[test]
fn an_ad_hoc_session_can_start_from_a_profile_and_own_args_come_after() {
    let h = Harness::new("profileadhoc");
    let _guard = h.rt.enter();
    h.core
        .set_profiles(vec![crate::store::Profile {
            name: "opus 版".into(),
            agent: "claude".into(),
            args: vec!["--model".into(), "opus".into()],
        }])
        .unwrap();

    let id = h
        .core
        .new_session(
            h.repo.to_string_lossy().into(),
            "opus 版".into(),
            vec!["--verbose".into()],
            100,
            30,
        )
        .unwrap();

    let args = h.args_of(&id);
    let model = args.iter().position(|a| a == "--model").expect("profile args present");
    let verbose = args.iter().position(|a| a == "--verbose").expect("own args present");
    assert!(model < verbose, "the person's own arguments must come after, so they can override: {args:?}");
    // The row remembers the resolved CLI, so reopening runs `claude`.
    let session = h.core.sessions().into_iter().find(|s| s.id == id).unwrap();
    assert_eq!(session.agent, "claude");
}

/// The queue stores the profile's *name*; what runs is whatever the profile
/// says when the slot finally frees.
#[test]
fn a_queued_start_resolves_its_profile_when_its_turn_comes() {
    let h = Harness::new("profilequeue");
    let _guard = h.rt.enter();
    h.core
        .set_profiles(vec![crate::store::Profile {
            name: "opus 版".into(),
            agent: "claude".into(),
            args: vec!["--model".into(), "opus".into()],
        }])
        .unwrap();
    h.core.set_max_concurrent(1).unwrap();
    let first = h.card("First", "p");
    let second = h.card("Second", "p");

    let a = h.start(&first, "claude");
    h.core
        .start_attempt(&second, "opus 版".into(), None, PermissionMode::Normal, 100, 30)
        .unwrap();
    h.core.close_session(&a.session_id).unwrap();

    let started = wait_for(Duration::from_secs(10), || {
        h.core
            .task_board()
            .into_iter()
            .find(|t| t.task.id == second)
            .map(|t| !t.attempts.is_empty())
            .unwrap_or(false)
    });
    assert!(started, "the queue never moved");
    let view = h
        .core
        .task_board()
        .into_iter()
        .find(|t| t.task.id == second)
        .unwrap();
    assert_eq!(view.attempts[0].attempt.agent, "claude");
    let session = view.attempts[0].session_id.clone().unwrap();
    let args = h.args_of(&session);
    assert!(args.windows(2).any(|w| w[0] == "--model" && w[1] == "opus"), "{args:?}");
}

/// Names have to mean one thing: no empties, no repeats, and none of them
/// may be an agent's own name while meaning something else.
#[test]
fn profiles_that_could_not_be_offered_are_refused() {
    let h = Harness::new("profilebad");
    let _guard = h.rt.enter();
    let profile = |name: &str, agent: &str| crate::store::Profile {
        name: name.into(),
        agent: agent.into(),
        args: Vec::new(),
    };

    assert!(h.core.set_profiles(vec![profile("", "claude")]).is_err());
    assert!(h.core.set_profiles(vec![profile("x", " ")]).is_err());
    assert!(
        h.core.set_profiles(vec![profile("claude", "codex")]).is_err(),
        "a profile shadowing an agent's own name is the confusion names exist to prevent"
    );
    assert!(h
        .core
        .set_profiles(vec![profile("mine", "claude"), profile("mine", "codex")])
        .is_err());

    // And nothing broken was stored along the way.
    assert!(h.core.profiles().unwrap().is_empty());

    // The launcher list is the four bare agents plus whatever is stored.
    h.core.set_profiles(vec![profile("mine", "claude")]).unwrap();
    let names: Vec<String> = h.core.launchers().unwrap().into_iter().map(|l| l.name).collect();
    assert_eq!(names, vec!["claude", "codex", "gemini", "aider", "mine"]);
}

/* --------------------------- permission modes -------------------------- */

/// The auto-accept switch, with the worktree as the safety case: the attempt
/// can only spend its own branch. Yolo adds Claude Code's own flag as an
/// option — and the prompt still rides last, after it.
#[test]
fn a_yolo_attempt_launches_claude_with_the_skip_permissions_flag() {
    let h = Harness::new("yolo");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");

    let opened = h
        .core
        .start_attempt(&task, "claude".into(), None, PermissionMode::Yolo, 100, 30)
        .unwrap()
        .attempt
        .unwrap();

    let args = h.args_of(&opened.session_id);
    assert!(
        args.contains(&"--dangerously-skip-permissions".to_string()),
        "yolo did not reach the command line: {args:?}"
    );
    assert_eq!(args.last(), Some(&opened.prompt));

    // Recorded on the attempt: the card can say this one runs unprompted.
    let attempt = h.core.task_board()[0].attempts[0].attempt.clone();
    assert_eq!(attempt.mode, PermissionMode::Yolo);
}

#[test]
fn accept_edits_maps_to_claudes_own_permission_mode_flag() {
    let h = Harness::new("acceptedits");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");

    let opened = h
        .core
        .start_attempt(&task, "claude".into(), None, PermissionMode::AcceptEdits, 100, 30)
        .unwrap()
        .attempt
        .unwrap();

    let args = h.args_of(&opened.session_id);
    let pair = args
        .windows(2)
        .any(|w| w[0] == "--permission-mode" && w[1] == "acceptEdits");
    assert!(pair, "acceptEdits did not reach the command line: {args:?}");
}

/// The mode was approved for the attempt, not for one launch: a resume after
/// a restart runs with it again, alongside `--continue`.
#[test]
fn resuming_a_yolo_attempt_keeps_the_mode() {
    let h = Harness::new("yoloresume");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h
        .core
        .start_attempt(&task, "claude".into(), None, PermissionMode::Yolo, 100, 30)
        .unwrap()
        .attempt
        .unwrap();
    h.launches(&a.session_id, 1);

    h.core.close_session(&a.session_id).unwrap();
    let session_id = h.core.reopen_attempt(&a.attempt_id, 100, 30).expect("reopen");

    let second = h.launches(&session_id, 2).pop().unwrap();
    assert!(second.args.iter().any(|x| x == "--continue"), "{:?}", second.args);
    assert!(
        second.args.iter().any(|x| x == "--dangerously-skip-permissions"),
        "the resume dropped the approved mode: {:?}",
        second.args
    );
}

/// Only Claude Code's flags are measured. Another CLI launches without them
/// no matter what the mode says — a flag guessed wrong can mean anything.
#[test]
fn another_cli_is_not_handed_claudes_permission_flags() {
    let h = Harness::new("yolocodex");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");

    let opened = h
        .core
        .start_attempt(&task, "codex".into(), None, PermissionMode::Yolo, 100, 30)
        .unwrap()
        .attempt
        .unwrap();

    assert!(
        h.args_of(&opened.session_id).is_empty(),
        "codex was handed flags that belong to claude"
    );
}

/// What was approved is what runs, even from the queue.
#[test]
fn a_queued_start_keeps_its_mode_when_its_turn_comes() {
    let h = Harness::new("yoloqueue");
    let _guard = h.rt.enter();
    h.core.set_max_concurrent(1).unwrap();
    let first = h.card("First", "p");
    let second = h.card("Second", "p");

    let a = h
        .core
        .start_attempt(&first, "claude".into(), None, PermissionMode::Normal, 100, 30)
        .unwrap();
    h.core
        .start_attempt(&second, "claude".into(), None, PermissionMode::Yolo, 100, 30)
        .unwrap();

    h.core.close_session(&a.attempt.unwrap().session_id).unwrap();
    let started = wait_for(Duration::from_secs(10), || {
        h.core
            .task_board()
            .into_iter()
            .find(|t| t.task.id == second)
            .map(|t| !t.attempts.is_empty())
            .unwrap_or(false)
    });
    assert!(started, "the queue never moved");

    let view = h
        .core
        .task_board()
        .into_iter()
        .find(|t| t.task.id == second)
        .unwrap();
    assert_eq!(view.attempts[0].attempt.mode, PermissionMode::Yolo);
    let session = view.attempts[0].session_id.clone().unwrap();
    assert!(h
        .args_of(&session)
        .contains(&"--dangerously-skip-permissions".to_string()));
}

/* --------------------------- workspace scripts ------------------------- */

/// M6's core promise: a fresh worktree is made runnable before the agent
/// starts, in the same terminal, and the agent still gets its argv untouched.
#[test]
fn setup_runs_in_the_worktree_before_the_agent_starts() {
    let h = Harness::new("setup");
    let _guard = h.rt.enter();
    h.config(r#"{ "setup": "echo tools-ready > setup-ran.txt" }"#);
    let task = h.card("Fix login", "make it work");

    let a = h.start(&task, "claude");

    // The setup left its mark in the worktree…
    let marker = std::path::PathBuf::from(&a.worktree_path).join("setup-ran.txt");
    assert!(
        wait_for(Duration::from_secs(10), || marker.exists()),
        "setup never ran in the worktree"
    );

    // …and the agent still launched with the prompt as its last argument,
    // exactly as it would have without the wrap. This is the property the
    // `exec "$0" "$@"` construction exists to keep.
    let args = h.args_of(&a.session_id);
    assert_eq!(args.last(), Some(&a.prompt));
    assert_eq!(
        std::fs::canonicalize(h.cwd_of(&a.session_id)).unwrap(),
        std::fs::canonicalize(&a.worktree_path).unwrap()
    );
}

/// `set -e`: a setup that fails stops in front of the person instead of
/// starting an agent in a half-made workspace.
#[test]
fn a_failed_setup_stops_before_the_agent_ever_starts() {
    let h = Harness::new("setupfail");
    let _guard = h.rt.enter();
    h.config(r#"{ "setup": "echo broken deps >&2; exit 7" }"#);
    let task = h.card("Fix login", "make it work");

    let a = h.start(&task, "claude");

    let exited = wait_for(Duration::from_secs(10), || {
        h.core
            .sessions()
            .iter()
            .any(|s| s.id == a.session_id && s.status == Status::Exited)
    });
    assert!(exited, "the failed setup did not end the session");
    assert!(
        !h.launched(&a.session_id),
        "the agent was started despite setup failing"
    );
}

/// A run script gets a terminal of its own in the attempt's worktree, a free
/// port, and the way back to the root repository — and it takes no slot,
/// because the quota rations agents, not dev servers.
#[test]
fn a_run_script_gets_its_own_terminal_a_port_and_the_root_path() {
    let h = Harness::new("runscript");
    let _guard = h.rt.enter();
    h.config(
        r#"{ "run": [{ "name": "srv",
             "command": "echo $AGENTDESK_PORT > port.txt; echo \"$AGENTDESK_ROOT_PATH\" > root.txt; exec cat" }] }"#,
    );
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    assert_eq!(h.core.list_run_scripts(&a.attempt_id).unwrap(), vec!["srv"]);
    let session_id = h.core.run_script(&a.attempt_id, "srv", 100, 30).expect("run");

    let wt = std::path::PathBuf::from(&a.worktree_path);
    assert!(
        wait_for(Duration::from_secs(10), || wt.join("port.txt").exists()
            && wt.join("root.txt").exists()),
        "the run script never wrote its files"
    );
    let port: u16 = std::fs::read_to_string(wt.join("port.txt"))
        .unwrap()
        .trim()
        .parse()
        .expect("AGENTDESK_PORT was not a port number");
    assert!(port > 0);
    assert_eq!(
        std::fs::read_to_string(wt.join("root.txt")).unwrap().trim(),
        h.repo.to_string_lossy()
    );

    // Ad-hoc: on nobody's card, against nobody's quota.
    let session = h
        .core
        .sessions()
        .into_iter()
        .find(|s| s.id == session_id)
        .expect("the run session is in the list");
    assert_eq!(session.attempt_id, None);
    assert_eq!(h.core.running_attempts(), 1, "the dev server took an agent's slot");

    // Closing the attempt takes the squatter with the directory it lived in.
    h.core.finish_attempt(&a.attempt_id, Outcome::Discarded).unwrap();
    assert!(
        !h.core.sessions().iter().any(|s| s.id == session_id),
        "a terminal survived the deletion of its own directory"
    );
}

/// The archive script runs while the worktree still exists, and the worktree
/// still comes back afterwards.
#[test]
fn the_archive_script_runs_before_the_worktree_goes_back() {
    let h = Harness::new("archive");
    let _guard = h.rt.enter();
    h.config(r#"{ "archive": "echo closed > \"$AGENTDESK_ROOT_PATH/archive-ran.txt\"" }"#);
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    h.core.finish_attempt(&a.attempt_id, Outcome::Discarded).unwrap();

    assert!(
        h.repo.join("archive-ran.txt").exists(),
        "the archive script never ran"
    );
    assert!(!std::path::Path::new(&a.worktree_path).exists());
}

/// A typo in the config fails the start in the dialog, not silently at the
/// first moment someone wonders why the worktree is broken.
#[test]
fn a_malformed_config_fails_the_start_where_the_person_can_see_it() {
    let h = Harness::new("badcfg");
    let _guard = h.rt.enter();
    h.config(r#"{ "setup": ["not", "a", "string"] }"#);
    let task = h.card("Fix login", "make it work");

    let err = h
        .core
        .start_attempt(&task, "claude".into(), None, PermissionMode::Normal, 100, 30)
        .expect_err("a config typo must be an error someone sees");
    assert!(err.to_string().contains("config.json"), "unhelpful: {err}");
    // And the worktree it would have used was given back.
    assert_eq!(h.core.running_attempts(), 0);
}

/* ------------------------------ the timeline --------------------------- */

/// The acceptance for M3's second half: enough of a record to say what this
/// attempt did without opening its terminal.
///
/// Hooks were only ever used to compute a badge and then dropped. This drives
/// the whole chain — listener, router, channel, writer thread, database.
#[test]
fn the_timeline_records_what_the_agent_reached_for() {
    let h = Harness::new("timeline");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    let tool = |name: &str, input: serde_json::Value| {
        serde_json::json!({ "hook_event_name": "PreToolUse", "tool_name": name, "tool_input": input })
    };
    h.hook(&a.session_id, "running", tool("Bash", serde_json::json!({ "command": "pytest -v" })));
    h.hook(
        &a.session_id,
        "running",
        tool("Edit", serde_json::json!({ "file_path": "/repo/auth.py" })),
    );
    // A repeat of the tool before it is still its own moment.
    h.hook(
        &a.session_id,
        "running",
        tool("Edit", serde_json::json!({ "file_path": "/repo/auth.py" })),
    );
    h.hook(&a.session_id, "waiting_permission", serde_json::Value::Null);
    h.hook(&a.session_id, "idle", serde_json::Value::Null);

    // The opening prompt, three tool calls, and two status changes.
    let rows = h.timeline(&a.attempt_id, 6);

    let kinds: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(kinds, vec!["prompt", "tool", "tool", "tool", "status", "status"]);

    let tools: Vec<Option<&str>> = rows.iter().map(|r| r.tool.as_deref()).collect();
    assert_eq!(
        tools,
        vec![None, Some("Bash"), Some("Edit"), Some("Edit"), None, None]
    );
    assert_eq!(rows[1].detail.as_deref(), Some("pytest -v"));
    assert_eq!(rows[2].detail.as_deref(), Some("/repo/auth.py"));
    assert_eq!(rows[4].detail.as_deref(), Some("waiting_permission"));
    assert_eq!(rows[5].detail.as_deref(), Some("idle"));
}

/// `running` is already implied by the tool call that carried it, and a
/// status line between every pair of tool calls would bury them.
#[test]
fn the_timeline_does_not_narrate_every_status_report() {
    let h = Harness::new("quiet");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    for _ in 0..3 {
        h.hook(
            &a.session_id,
            "running",
            serde_json::json!({ "hook_event_name": "UserPromptSubmit" }),
        );
    }
    h.hook(&a.session_id, "idle", serde_json::Value::Null);
    // Reported twice; it only changed once.
    h.hook(&a.session_id, "idle", serde_json::Value::Null);

    // Wait for the two we do expect, then give any extras time to show up
    // before asserting that there are none.
    h.timeline(&a.attempt_id, 2);
    std::thread::sleep(Duration::from_millis(300));
    let rows = h.core.attempt_events(&a.attempt_id).unwrap();
    assert_eq!(
        rows.len(),
        2,
        "expected the prompt and one idle, got {rows:?}"
    );
    assert_eq!(rows[1].detail.as_deref(), Some("idle"));
}

/// Hooks from an ad-hoc session have no attempt to file against. They still
/// have to drive the badge without inventing a timeline.
#[test]
fn an_ad_hoc_sessions_hooks_do_not_land_on_anybodys_timeline() {
    let h = Harness::new("adhoc");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");
    let scratch = h
        .core
        .new_session(h.repo.to_string_lossy().into(), "claude".into(), vec![], 100, 30)
        .unwrap();

    h.hook(
        &scratch,
        "running",
        serde_json::json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash",
                            "tool_input": { "command": "ls" } }),
    );
    h.hook(&scratch, "waiting_permission", serde_json::Value::Null);
    std::thread::sleep(Duration::from_millis(300));

    // Only the opening prompt, from the attempt itself.
    assert_eq!(h.core.attempt_events(&a.attempt_id).unwrap().len(), 1);
    // But the ad-hoc session is still blocking a person, so it still counts.
    let waiting = h.core.sessions().iter().filter(|s| s.status.needs_you()).count();
    assert_eq!(waiting, 2);
}

/// The diff has to answer "what changed" while the attempt is still running,
/// not only once it has been closed out.
#[test]
fn a_running_attempts_diff_is_read_live_from_its_worktree() {
    let h = Harness::new("livediff");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    assert_eq!(
        h.core.attempt_diff(&a.attempt_id).unwrap(),
        "",
        "an attempt that has changed nothing has an empty diff"
    );

    std::fs::write(Path::new(&a.worktree_path).join("app.txt"), "half done\n").unwrap();
    std::fs::write(Path::new(&a.worktree_path).join("scratch.rs"), "fn new() {}\n").unwrap();

    let diff = h.core.attempt_diff(&a.attempt_id).unwrap();
    assert!(diff.contains("half done"), "the edit is missing:\n{diff}");
    assert!(diff.contains("scratch.rs"), "the new file is missing:\n{diff}");
    assert!(diff.contains("fn new() {}"), "its contents are missing:\n{diff}");
}

/* ------------------------------ the board ------------------------------ */

#[test]
fn a_card_pointing_at_something_that_is_not_a_repository_is_refused() {
    let h = Harness::new("notrepo");
    let _guard = h.rt.enter();
    let plain = h.root.join("plain");
    std::fs::create_dir_all(&plain).unwrap();

    let err = h
        .core
        .create_task(
            "x".into(),
            "y".into(),
            plain.to_string_lossy().into(),
            "main".into(),
        )
        .expect_err("a card that can never run must not be created");
    assert!(err.to_string().contains("not a git repository"), "{err}");
    assert!(h.core.task_board().is_empty());
}

#[test]
fn a_card_naming_a_base_branch_that_does_not_exist_is_refused() {
    let h = Harness::new("nobranch");
    let _guard = h.rt.enter();
    let err = h
        .core
        .create_task(
            "x".into(),
            "y".into(),
            h.repo.to_string_lossy().into(),
            "develop".into(),
        )
        .expect_err("a missing base branch must be caught when the card is made");
    assert!(err.to_string().contains("no branch `develop`"), "{err}");
}

/// Dragging a card renumbers the column it left as well as the one it joined,
/// or the gap it leaves behind changes what "position 2" means.
#[test]
fn moving_a_card_renumbers_the_column_it_left_and_the_one_it_joined() {
    let h = Harness::new("move");
    let _guard = h.rt.enter();
    let a = h.card("A", "p");
    let b = h.card("B", "p");
    let c = h.card("C", "p");

    // Backlog is A, B, C. Move B to the front of review.
    h.core.move_task(&b, Lifecycle::Review, 0).unwrap();

    let board = h.core.task_board();
    let backlog: Vec<_> = board
        .iter()
        .filter(|t| t.task.lifecycle == Lifecycle::Backlog)
        .map(|t| (t.task.id.clone(), t.task.position))
        .collect();
    assert_eq!(backlog, vec![(a.clone(), 0), (c.clone(), 1)], "gap left behind");

    let review: Vec<_> = board
        .iter()
        .filter(|t| t.task.lifecycle == Lifecycle::Review)
        .map(|t| (t.task.id.clone(), t.task.position))
        .collect();
    assert_eq!(review, vec![(b.clone(), 0)]);

    // And back again, into the middle this time.
    h.core.move_task(&b, Lifecycle::Backlog, 1).unwrap();
    let order: Vec<_> = h
        .core
        .task_board()
        .into_iter()
        .filter(|t| t.task.lifecycle == Lifecycle::Backlog)
        .map(|t| t.task.id)
        .collect();
    assert_eq!(order, vec![a, b, c]);
}

/// Deleting a card must take its worktrees with it, or the directories
/// outlive every record that they ever existed.
#[test]
fn deleting_a_card_gives_back_the_worktrees_its_attempts_were_holding() {
    let h = Harness::new("delete");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");
    assert!(Path::new(&a.worktree_path).is_dir());

    h.core.delete_task(&task).unwrap();

    assert!(h.core.task_board().is_empty());
    assert!(
        !Path::new(&a.worktree_path).exists(),
        "the worktree outlived the card that made it"
    );
}

/* --------------------------- editable diff ------------------------------ */

/// The editable diff's two commands through the core: the mid-turn refusal
/// happens here and not just in the UI, the settled write lands on disk
/// exactly, and both sides of the file read back — base as committed, work
/// as written.
#[test]
fn a_hand_edit_is_refused_mid_turn_and_lands_once_the_attempt_settles() {
    let h = Harness::new("editfile");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    // Fresh from launch the session is live and unsettled: the core must
    // refuse, whatever buttons the UI happens to be hiding.
    let err = h
        .core
        .write_attempt_file(&a.attempt_id, "app.txt", "hand edit\n", None)
        .expect_err("a mid-turn write must be refused");
    assert!(err.to_string().contains("mid-turn"), "unhelpful: {err}");

    // The turn ends; the same write is now a person editing their own repo.
    h.hook(&a.session_id, "idle", serde_json::Value::Null);
    assert!(
        wait_for(Duration::from_secs(5), || h
            .core
            .write_attempt_file(&a.attempt_id, "app.txt", "hand edit\n", Some("one\n"))
            .is_ok()),
        "a settled write must go through"
    );
    assert_eq!(
        std::fs::read_to_string(Path::new(&a.worktree_path).join("app.txt")).unwrap(),
        "hand edit\n"
    );

    let file = h.core.attempt_file(&a.attempt_id, "app.txt").unwrap();
    assert_eq!(file.base.as_deref(), Some("one\n"));
    assert_eq!(file.work.as_deref(), Some("hand edit\n"));

    // The freshness contract: an editor still believing the disk holds the
    // base text is stale — the write above moved it — and last-write-wins
    // would erase that unseen. Refused, with the reason.
    let err = h
        .core
        .write_attempt_file(&a.attempt_id, "app.txt", "third\n", Some("one\n"))
        .expect_err("a stale write must be refused");
    assert!(err.to_string().contains("changed on disk"), "unhelpful: {err}");
    h.core
        .write_attempt_file(&a.attempt_id, "app.txt", "third\n", Some("hand edit\n"))
        .expect("the fresh expectation goes through");

    // A file the attempt never touched at base, deleted in the worktree:
    // work side None, not an error.
    std::fs::remove_file(Path::new(&a.worktree_path).join("app.txt")).unwrap();
    let gone = h.core.attempt_file(&a.attempt_id, "app.txt").unwrap();
    assert!(gone.work.is_none());

    // Paths that would leave the worktree stop at the invoke boundary.
    assert!(h
        .core
        .write_attempt_file(&a.attempt_id, "../escape.txt", "x", None)
        .is_err());

    // Parked there is no ground to read or write; both commands say so.
    h.core.park_attempt(&a.attempt_id).unwrap();
    assert!(h.core.attempt_file(&a.attempt_id, "app.txt").is_err());
    assert!(h
        .core
        .write_attempt_file(&a.attempt_id, "app.txt", "y", None)
        .is_err());
}

/* ---------------------------- token account ----------------------------- */

/// The whole cost pipeline end to end: a Stop hook whose body names the
/// transcript, the turn-end read on its own thread, and the account landing
/// on the session for the next broadcast — incrementally, so the second
/// turn only pays for its own lines.
#[test]
fn a_turns_end_reads_the_transcript_and_the_account_lands_on_the_session() {
    let h = Harness::new("usage");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");

    let transcript = h.root.join("transcript.jsonl");
    std::fs::write(
        &transcript,
        concat!(
            r#"{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50}}}"#,
            "\n",
        ),
    )
    .unwrap();

    // The Stop payload, as Claude Code posts it: common fields in the body.
    h.hook(
        &a.session_id,
        "idle",
        serde_json::json!({
            "hook_event_name": "Stop",
            "transcript_path": transcript.to_string_lossy(),
        }),
    );
    assert!(
        wait_for(Duration::from_secs(5), || {
            h.core
                .sessions()
                .iter()
                .find(|s| s.id == a.session_id)
                .and_then(|s| s.usage)
                .is_some_and(|u| u.output == 100 && u.context == 1060)
        }),
        "the first turn's account never landed: {:?}",
        h.core.sessions().iter().find(|s| s.id == a.session_id).and_then(|s| s.usage)
    );

    // The next turn appends — a sidechain (spend counts, context must not
    // move to it) and a main-line row. Totals accumulate across reads.
    let mut file = std::fs::OpenOptions::new().append(true).open(&transcript).unwrap();
    use std::io::Write as _;
    writeln!(
        file,
        r#"{{"type":"assistant","isSidechain":true,"message":{{"usage":{{"input_tokens":1,"output_tokens":40,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
    )
    .unwrap();
    writeln!(
        file,
        r#"{{"type":"assistant","message":{{"usage":{{"input_tokens":2,"output_tokens":60,"cache_read_input_tokens":2000,"cache_creation_input_tokens":8}}}}}}"#
    )
    .unwrap();
    drop(file);

    h.hook(&a.session_id, "running", serde_json::Value::Null);
    h.hook(&a.session_id, "idle", serde_json::Value::Null);
    assert!(
        wait_for(Duration::from_secs(5), || {
            h.core
                .sessions()
                .iter()
                .find(|s| s.id == a.session_id)
                .and_then(|s| s.usage)
                .is_some_and(|u| u.output == 200 && u.context == 2010 && u.input == 13)
        }),
        "the second turn's increment never landed: {:?}",
        h.core.sessions().iter().find(|s| s.id == a.session_id).and_then(|s| s.usage)
    );
}

/// The badge counts what is blocking a person, across the board and the
/// ad-hoc sessions alike, because they are the same list underneath.
#[test]
fn the_badge_counts_attempts_and_ad_hoc_sessions_together() {
    let h = Harness::new("badge");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    h.start(&task, "claude");
    h.core
        .new_session(h.repo.to_string_lossy().into(), "claude".into(), vec![], 100, 30)
        .unwrap();

    let waiting = h.core.sessions().iter().filter(|s| s.status.needs_you()).count();
    // The attempt is on its trust prompt; the ad-hoc session is not, because
    // its directory is one the person already chose.
    assert_eq!(waiting, 1, "{:?}", h.core.sessions());
}

/// A held session survives the app, and the next start says so.
///
/// `from_stored` marks everything `Saved`, which was true when every terminal
/// died with the app. With tmux holding local sessions it is not, and a card
/// reading "closed" over a working agent is how somebody starts a second
/// attempt onto the same worktree.
///
/// Skipped where tmux is absent: there is nothing to hold sessions with, so
/// there is nothing to be honest or dishonest about.
#[test]
fn a_session_tmux_kept_running_does_not_come_back_as_closed() {
    if std::process::Command::new("tmux").arg("-V").output().is_err() {
        eprintln!("no tmux on PATH — nothing holds sessions here");
        return;
    }
    let h = Harness::new("detached");
    let _guard = h.rt.enter();
    let task = h.card("Fix login", "make it work");
    let a = h.start(&task, "claude");
    h.launches(&a.session_id, 1);

    // The endpoint this session was told to report to. Its plugin config has
    // this string baked into it now, and Claude Code reads that file once, so
    // this is the only address it will ever have.
    let told = h.core.hook_url().expect("the hook server is up");

    // The agent is running under tmux. Quitting drops the client and leaves
    // it there — which is `shutdown`, exactly what closing the window does.
    h.core.shutdown();

    // A fresh core over the same database and data dir: the restart.
    let core2 = h
        .rt
        .block_on(Core::start_with(
            h.env.clone(),
            Arc::new(Events::default()) as Arc<dyn UiSink>,
            h.root.join("agentdesk.db"),
            h.root.join("data"),
            h.root.join("worktrees"),
        ))
        .expect("second core");

    let seen = core2
        .sessions()
        .into_iter()
        .find(|s| s.id == a.session_id)
        .expect("the session is still on the list");
    assert_eq!(
        seen.status,
        Status::Detached,
        "a session tmux kept running came back as {:?}",
        seen.status,
    );
    // Not live: no pty in *this* process carries it yet. Opening attaches.
    assert!(!seen.live, "nothing is attached to it in this process");

    // The cause, not the symptom. Whether the held agent's reports arrive is
    // decided entirely by whether this string is the one it was told, so that
    // is what is asserted: not "a status eventually appeared", which could
    // pass for a dozen unrelated reasons, but "the address did not move".
    assert_eq!(
        core2.hook_url().as_deref(),
        Some(told.as_str()),
        "the endpoint moved, so every session held through the restart is \
         posting into nothing for the rest of its life",
    );

    // Attaching is not starting. `new-session -A -D` reattaches to the agent
    // and drops the argv, so no SessionStart will ever fire for it — a row
    // that said 啟動中 here would say it forever.
    core2
        .reopen_session(&a.session_id, 100, 30)
        .expect("reattach to the held session");
    let after = core2
        .sessions()
        .into_iter()
        .find(|s| s.id == a.session_id)
        .expect("still on the list");
    assert_ne!(
        after.status,
        Status::Starting,
        "reattaching claimed the agent was starting; nothing would ever correct that",
    );
    assert_eq!(after.status, Status::Detached, "running, and not yet heard from");
    assert!(after.live, "a terminal in this process carries it now");

    core2.shutdown();
}
