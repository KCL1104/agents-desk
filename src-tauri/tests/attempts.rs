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
const STUB: &str = r#"#!/bin/bash
printf '%s\0' "$PWD" "$@" > "$AGENTDESK_STUB_LOG/${AGENTDESK_SESSION_ID:-unknown}.$$"
exec cat > "$AGENTDESK_STUB_LOG/stdin.${AGENTDESK_SESSION_ID:-unknown}.$$"
"#;

impl Harness {
    fn new(name: &str) -> Self {
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
        for agent in ["claude", "codex"] {
            let p = bin.join(agent);
            std::fs::write(&p, STUB).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
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
                env,
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
