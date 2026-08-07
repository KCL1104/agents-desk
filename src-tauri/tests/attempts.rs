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

#[path = "../src/core.rs"]
mod core;
#[path = "../src/hooks.rs"]
mod hooks;
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
use crate::store::{Lifecycle, Outcome};

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
/// argument it was given, then stays alive so the session looks the way a
/// real one does.
///
/// NUL-separated, because the argument under test is a multi-line prompt and
/// a line-per-argument log cannot tell one argument containing newlines from
/// several arguments — which is exactly the distinction these tests exist to
/// make. One file per launch, named by pid, so reopening a session leaves the
/// first launch's record intact beside the second's.
const STUB: &str = r#"#!/bin/bash
printf '%s\0' "$PWD" "$@" > "$AGENTDESK_STUB_LOG/${AGENTDESK_SESSION_ID:-unknown}.$$"
exec sleep 60
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

    let opened = h
        .core
        .open_attempt(&task, "claude".into(), None, 100, 30)
        .expect("open attempt");

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

    let a = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();
    let b = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();

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
    let a = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();

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
    let a = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();
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
    let a = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();
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

    let opened = h.core.open_attempt(&task, "codex".into(), None, 100, 30).unwrap();

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
        .open_attempt(&task, "claude".into(), Some(edited.clone()), 100, 30)
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
    let a = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();

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
    let a = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();

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
    let a = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();
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
    let a = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();

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
    let a = h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();
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
    h.core.open_attempt(&task, "claude".into(), None, 100, 30).unwrap();
    h.core
        .new_session(h.repo.to_string_lossy().into(), "claude".into(), vec![], 100, 30)
        .unwrap();

    let waiting = h.core.sessions().iter().filter(|s| s.status.needs_you()).count();
    // The attempt is on its trust prompt; the ad-hoc session is not, because
    // its directory is one the person already chose.
    assert_eq!(waiting, 1, "{:?}", h.core.sessions());
}
