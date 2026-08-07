//! How a task prompt reaches a fresh worktree session.
//!
//! Opening an attempt means: create a worktree, spawn `claude` in it, and hand
//! it the task prompt. Two things about that were undocumented and had to be
//! measured, because both decide the shape of the implementation:
//!
//!   * A prompt passed as the positional argument keeps the interactive TUI
//!     (`-p`/`--print` is what makes it non-interactive) and is submitted as
//!     **one** message even when it spans several lines. Newlines in `argv`
//!     are text, not Enter keystrokes.
//!   * A brand-new worktree is a directory Claude Code has never seen, so it
//!     opens on the trust prompt. Nothing runs until that is answered — but
//!     the positional prompt **survives** the gate and is submitted once it is.
//!
//! Run with output to see the whole exchange:
//!
//!     cargo test --test prompt_injection -- --nocapture

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod common;

#[path = "../src/pty.rs"]
mod pty;
#[path = "../src/shell_env.rs"]
mod shell_env;

use crate::pty::{PtyRegistry, PtySink};

/// The multi-line shape the real template produces: a Chinese header, blank
/// lines, a `---` separator, and the user's own prompt underneath. If any of
/// those were treated as a submit, this would arrive as several messages.
fn probe_prompt(base_sha: &str) -> String {
    format!(
        "[AgentDesk 任務] 探針測試\n\
         \n\
         你在一個專為這張卡開的 git worktree：分支 agentdesk/probe-1，從 main @ {} 開出。\n\
         這個 worktree 只屬於這張卡，不要切換分支。\n\
         \n\
         ---\n\
         \n\
         請只回覆 PROBE-OK，不要使用任何工具。",
        &base_sha[..8]
    )
}

#[derive(Default)]
struct Capture {
    /// `(event name, raw body)` for every hook the probe plugin fired.
    events: Mutex<Vec<(String, String)>>,
    output: Mutex<String>,
}

impl PtySink for Capture {
    fn on_output(&self, _id: &str, data: String, _seq: u64) {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .unwrap_or_default();
        self.output
            .lock()
            .unwrap()
            .push_str(&String::from_utf8_lossy(&bytes));
    }
    fn on_exit(&self, _id: &str, _status: String) {}
}

impl Capture {
    fn count(&self, event: &str) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == event)
            .count()
    }

    fn first_body(&self, event: &str) -> Option<String> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .find(|(e, _)| e == event)
            .map(|(_, b)| b.clone())
    }
}

/// A listener that keeps the whole request, unlike the production one which
/// only keeps what it needs. The probe is measuring what Claude Code sends.
fn capture_listener(cap: Arc<Capture>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut s) = stream else { continue };
            let cap = Arc::clone(&cap);
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 8192];
                let head_end = loop {
                    match s.read(&mut chunk) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                    if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break p;
                    }
                    if buf.len() > 4 * 1024 * 1024 {
                        return;
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                let target = head
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("")
                    .to_string();
                let clen: usize = head
                    .lines()
                    .filter_map(|l| l.split_once(':'))
                    .find(|(k, _)| k.trim().eq_ignore_ascii_case("content-length"))
                    .and_then(|(_, v)| v.trim().parse().ok())
                    .unwrap_or(0);
                let mut body = buf.split_off(head_end + 4);
                while body.len() < clen {
                    match s.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => body.extend_from_slice(&chunk[..n]),
                    }
                }
                let event = target
                    .split("e=")
                    .nth(1)
                    .map(|v| v.split('&').next().unwrap_or("").to_string())
                    .unwrap_or_default();
                eprintln!("  hook: {event} ({} body bytes)", body.len());
                cap.events
                    .lock()
                    .unwrap()
                    .push((event, String::from_utf8_lossy(&body).into_owned()));
                let _ = s.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                );
            });
        }
    });
    port
}

/// A plugin that names the event in the query, so the probe can tell
/// `UserPromptSubmit` from `PreToolUse` — production collapses both onto
/// "running", which is the right thing there and useless here.
fn write_probe_plugin(dir: &Path, url: &str) {
    let manifest_dir = dir.join(".claude-plugin");
    let hooks_dir = dir.join("hooks");
    std::fs::create_dir_all(&manifest_dir).unwrap();
    std::fs::create_dir_all(&hooks_dir).unwrap();
    std::fs::write(
        manifest_dir.join("plugin.json"),
        serde_json::json!({
            "name": "agentdesk-probe",
            "version": "0.0.0",
            "description": "Measures how a task prompt reaches a session."
        })
        .to_string(),
    )
    .unwrap();

    let http = |event: &str| {
        serde_json::json!({
            "type": "http",
            "url": format!("{url}?e={event}"),
            "timeout": 2
        })
    };
    // `command`, because an http hook on SessionStart never fires. `|| true`,
    // because a non-zero exit blocks the action it fired on. `shell` unset,
    // because "sh" makes the hook silently not run. All three measured; see
    // the README.
    let session_start = serde_json::json!({
        "type": "command",
        "command": format!(
            "curl -sS --max-time 2 -X POST \"{url}?e=SessionStart\" -o /dev/null || true"
        ),
        "async": true,
        "timeout": 5
    });

    std::fs::write(
        hooks_dir.join("hooks.json"),
        serde_json::json!({
            "hooks": {
                "SessionStart":     [{ "hooks": [session_start] }],
                "UserPromptSubmit": [{ "hooks": [http("UserPromptSubmit")] }],
                "PreToolUse":       [{ "matcher": "*", "hooks": [http("PreToolUse")] }],
                "Stop":             [{ "hooks": [http("Stop")] }],
            }
        })
        .to_string(),
    )
    .unwrap();
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git must be installed");
    assert!(
        out.status.success(),
        "git {args:?} in {} failed: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn wait_until(timeout: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Strip escape sequences so a failure message shows the words on screen.
fn visible(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            while let Some(&n) = chars.peek() {
                chars.next();
                if n.is_ascii_alphabetic() || n == '~' {
                    break;
                }
            }
        } else if c == '\n' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

#[test]
fn a_multi_line_prompt_reaches_a_fresh_worktree_as_one_message() {
    let env = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(shell_env::resolve());
    if !common::require_claude(env.which("claude").is_some()) {
        return;
    }

    let root = std::env::temp_dir().join(format!("agentdesk-prompt-probe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let repo = root.join("repo");
    let wt = root.join("wt");
    std::fs::create_dir_all(&repo).unwrap();

    git(&repo, &["init", "-b", "main", "-q"]);
    git(&repo, &["config", "user.email", "probe@agentdesk.test"]);
    git(&repo, &["config", "user.name", "AgentDesk Probe"]);
    std::fs::write(repo.join("README.md"), "probe\n").unwrap();
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "init"]);
    let base_sha = git(&repo, &["rev-parse", "HEAD"]);

    // The real thing: an attempt runs in a worktree, not in the repo.
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "agentdesk/probe-1",
            &wt.to_string_lossy(),
            "main",
        ],
    );
    assert!(wt.join(".git").is_file(), "a worktree's .git is a file");

    let cap = Arc::new(Capture::default());
    let port = capture_listener(Arc::clone(&cap));
    let url = format!("http://127.0.0.1:{port}/h");
    let plugin_dir = root.join("plugin");
    write_probe_plugin(&plugin_dir, &url);

    let prompt = probe_prompt(&base_sha);
    eprintln!("--- prompt ({} bytes, {} lines) ---\n{prompt}\n---", prompt.len(), prompt.lines().count());

    let sid = "probe-session";
    let reg = PtyRegistry::new();
    // Options first, positional last. `--plugin-dir` takes one value, so the
    // prompt cannot be swallowed by it — but building the vector this way
    // keeps that true if a variadic option is ever added.
    reg.spawn(
        sid,
        "claude",
        &[
            "--plugin-dir".to_string(),
            plugin_dir.to_string_lossy().to_string(),
            prompt.clone(),
        ],
        &wt.to_string_lossy().to_string(),
        &env,
        &[("AGENTDESK_SESSION_ID".to_string(), sid.to_string())],
        100,
        30,
        Arc::clone(&cap) as Arc<dyn PtySink>,
    )
    .expect("spawn claude under pty");

    // A directory Claude Code has not seen opens on the trust prompt and
    // nothing runs until it is answered. Answer it the way a user would.
    let painted = wait_until(Duration::from_secs(30), || {
        let o = cap.output.lock().unwrap();
        o.contains("trust") || o.len() > 800
    });
    assert!(painted, "the TUI never painted");
    let saw_trust = cap.output.lock().unwrap().contains("trust");
    std::thread::sleep(Duration::from_millis(600));
    reg.write(sid, "\r").expect("answer the trust prompt");

    let submitted = wait_until(Duration::from_secs(60), || cap.count("UserPromptSubmit") > 0);

    // Give any second submission time to show up before counting — the
    // failure this guards against is the prompt arriving as several messages,
    // which would look identical to one until the rest land.
    std::thread::sleep(Duration::from_secs(3));

    let submits = cap.count("UserPromptSubmit");
    let body = cap.first_body("UserPromptSubmit");
    let screen = visible(&cap.output.lock().unwrap());
    reg.kill(sid);

    eprintln!("\n--- findings ---");
    eprintln!("trust prompt shown for a fresh worktree: {saw_trust}");
    eprintln!("SessionStart hooks: {}", cap.count("SessionStart"));
    eprintln!("UserPromptSubmit hooks: {submits}");
    eprintln!("PreToolUse hooks: {}", cap.count("PreToolUse"));
    eprintln!("--- screen ---\n{}\n---", screen.trim());

    let _ = std::fs::remove_dir_all(&root);

    assert!(
        submitted,
        "the positional prompt was never submitted. Screen:\n{}",
        screen.trim()
    );
    assert_eq!(
        submits, 1,
        "a multi-line prompt must arrive as one message, not {submits}. \
         If this is >1, argv newlines are being treated as Enter and the \
         prompt has to go in over stdin or be written to the PTY in one write."
    );

    // The whole prompt must survive, not just its first line.
    let body = body.expect("UserPromptSubmit carried no body");
    let payload: serde_json::Value = serde_json::from_str(&body).expect("hook body is JSON");
    let seen = payload
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(
        seen.contains("[AgentDesk 任務] 探針測試") && seen.contains("請只回覆 PROBE-OK"),
        "the prompt was truncated on the way in. First 400 bytes of what arrived:\n{}",
        &seen.chars().take(400).collect::<String>()
    );
}
