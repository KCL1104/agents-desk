//! End-to-end proof of the status pipeline:
//!
//!   PTY -> real `claude` -> our plugin's hook -> curl -> our HTTP listener
//!
//! `SessionStart` fires as soon as the session comes up, so the whole chain is
//! provable without sending a prompt and without a billable API call.
//!
//!     cargo test --test hooks -- --nocapture

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

mod common;

#[path = "../src/hooks.rs"]
mod hooks;
#[path = "../src/pty.rs"]
mod pty;
#[path = "../src/shell_env.rs"]
mod shell_env;

use crate::hooks::{HookHandler, HookReport, HookState};
use crate::pty::{PtyRegistry, PtySink};

#[derive(Default)]
struct Recorder {
    states: Mutex<Vec<(String, HookState)>>,
    activities: Mutex<Vec<(String, crate::hooks::Activity)>>,
    output: Mutex<String>,
}

impl HookHandler for Recorder {
    fn on_hook(&self, report: HookReport) {
        // A report whose session id never made it through the shell is
        // recorded under its working directory, which is how the production
        // router places it too. Either way it is a string that identifies
        // one session, which is all this recorder needs.
        let who = report
            .session_id
            .clone()
            .or_else(|| report.cwd.clone())
            .unwrap_or_default();
        eprintln!(
            "  hook: {who} -> {:?}{}",
            report.state,
            report
                .activity
                .as_ref()
                .map(|a| format!(" [{} {}]", a.tool, a.detail))
                .unwrap_or_default()
        );
        if let Some(a) = report.activity.clone() {
            self.activities.lock().unwrap().push((who.clone(), a));
        }
        self.states.lock().unwrap().push((who, report.state));
    }
}

impl PtySink for Recorder {
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

#[test]
fn a_pty_session_reports_its_status_back_through_the_plugin() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let env = rt.block_on(shell_env::resolve());

    if !common::require_claude(env.which("claude").is_some()) {
        return;
    }

    let rec = Arc::new(Recorder::default());
    let data_dir = std::env::temp_dir().join(format!("marol-hooktest-{}", std::process::id()));
    let cwd = data_dir.join("work");
    std::fs::create_dir_all(&cwd).unwrap();

    let server = rt
        .block_on(hooks::start(&data_dir, rec.clone() as Arc<dyn HookHandler>))
        .expect("hook listener");
    eprintln!("listener at {}", server.url());

    // Keep the runtime alive: the listener task lives on it, so dropping the
    // runtime here would stop answering before the hook ever fires.
    let _guard = rt.enter();

    let sid = "test-session-1";
    let reg = PtyRegistry::new();
    reg.spawn(
        sid,
        "claude",
        &[
            "--plugin-dir".to_string(),
            server.plugin_dir.to_string_lossy().to_string(),
        ],
        Some(&cwd.to_string_lossy().to_string()),
        &env,
        &[
            ("MAROL_SESSION_ID".to_string(), sid.to_string()),
            ("MAROL_HOOK_URL".to_string(), server.url()),
        ],
        100,
        30,
        rec.clone() as Arc<dyn PtySink>,
        None,
    )
    .expect("spawn claude under pty");

    // A directory Claude Code has not seen before opens on a trust prompt
    // ("Is this a project you created or one you trust?") and nothing else
    // happens until it is answered — including SessionStart. That gate is
    // correct product behaviour, so the test answers it the way a user would
    // rather than bypassing it.
    let painted = wait_until(Duration::from_secs(30), || {
        rec.output.lock().unwrap().contains("trust")
            || rec.output.lock().unwrap().len() > 800
    });
    assert!(painted, "the TUI never painted");
    std::thread::sleep(Duration::from_millis(500));
    reg.write(sid, "\r").expect("confirm the trust prompt");

    let got = wait_until(Duration::from_secs(60), || {
        !rec.states.lock().unwrap().is_empty()
    });

    let states = rec.states.lock().unwrap().clone();
    let output_len = rec.output.lock().unwrap().len();
    reg.kill(sid);
    let _ = std::fs::remove_dir_all(&data_dir);

    if !got {
        let raw = rec.output.lock().unwrap().clone();
        // Strip escape sequences so the failure shows the words on screen.
        let mut visible = String::new();
        let mut chars = raw.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '\u{1b}' {
                while let Some(&n) = chars.peek() {
                    chars.next();
                    if n.is_ascii_alphabetic() || n == '~' { break; }
                }
            } else if c == '\n' || !c.is_control() {
                visible.push(c);
            }
        }
        panic!(
            "no hook arrived in 60s. {output_len} bytes of TUI output, screen text:\n---\n{}\n---\n\
             (if this shows a trust prompt, the confirm keystroke did not land)",
            visible.trim()
        );
    }

    // The session id must survive the trip, otherwise status would land on the
    // wrong row once more than one session is open.
    assert!(
        states.iter().all(|(id, _)| id == sid),
        "hook reported the wrong session id: {states:?}"
    );
    assert!(
        states.iter().any(|(_, s)| *s == HookState::Started),
        "expected a SessionStart report, saw {states:?}"
    );
    eprintln!("received {} hook report(s): {states:?}", states.len());
}


/// The listener's own parsing, driven with the exact request shapes Claude
/// Code sends. Probe runs proved what it emits; this proves we read it.
#[test]
fn the_listener_reads_both_hook_shapes() {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let rt = tokio::runtime::Runtime::new().unwrap();
    let rec = Arc::new(Recorder::default());
    let dir = std::env::temp_dir().join(format!("marol-listener-{}", std::process::id()));

    let server = rt
        .block_on(hooks::start(&dir, rec.clone() as Arc<dyn HookHandler>))
        .expect("listener");
    let _guard = rt.enter();

    let addr = format!("127.0.0.1:{}", server.port);
    let path = format!("/h/{}", server.token);

    let post = |target: String, headers: String, body: String| {
        let mut sock = TcpStream::connect(&addr).unwrap();
        let req = format!(
            "POST {target} HTTP/1.1\r\nHost: localhost\r\n{headers}content-length: {}\r\n\r\n{body}",
            body.len()
        );
        sock.write_all(req.as_bytes()).unwrap();
        let mut resp = String::new();
        let _ = sock.read_to_string(&mut resp);
        assert!(resp.starts_with("HTTP/1.1 200"), "listener must always answer 200: {resp}");
    };

    // An `http` hook: identity in a header, payload in the body.
    post(
        format!("{path}?state=running"),
        "X-Marol-Session: sess-http\r\n".to_string(),
        serde_json::json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": { "command": "pytest tests/ -v", "description": "Run tests" }
        })
        .to_string(),
    );

    // The `command` hook that covers SessionStart: identity in the query,
    // no body at all.
    post(
        format!("{path}?sid=sess-cmd&state=started"),
        String::new(),
        String::new(),
    );

    // A body larger than the read cap must still be drained and answered,
    // or the agent would stall waiting to finish its write.
    post(
        format!("{path}?state=running"),
        "X-Marol-Session: sess-big\r\n".to_string(),
        serde_json::json!({
            "tool_name": "Write",
            "tool_input": { "file_path": "/repo/big.txt", "content": "z".repeat(200_000) }
        })
        .to_string(),
    );

    // A request without the token must be ignored, so another local process
    // cannot forge status.
    post(
        "/h/wrong-token?sid=intruder&state=idle".to_string(),
        String::new(),
        String::new(),
    );

    let deadline = Instant::now() + Duration::from_secs(5);
    while rec.states.lock().unwrap().len() < 3 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }

    let got = rec.states.lock().unwrap().clone();
    let acts = rec.activities.lock().unwrap().clone();
    let _ = std::fs::remove_dir_all(&dir);

    assert!(
        got.iter().any(|(id, st)| id == "sess-http" && *st == HookState::Running),
        "header identity was not read: {got:?}"
    );
    assert!(
        got.iter().any(|(id, st)| id == "sess-cmd" && *st == HookState::Started),
        "query identity was not read: {got:?}"
    );
    assert!(
        got.iter().any(|(id, _)| id == "sess-big"),
        "an oversized body was dropped instead of drained: {got:?}"
    );
    assert!(
        !got.iter().any(|(id, _)| id == "intruder"),
        "a request with the wrong token was accepted: {got:?}"
    );

    let bash = acts
        .iter()
        .find(|(id, _)| id == "sess-http")
        .map(|(_, a)| a.clone())
        .expect("no activity recorded for the tool call");
    assert_eq!(bash.tool, "Bash");
    assert_eq!(bash.detail, "pytest tests/ -v");
}
