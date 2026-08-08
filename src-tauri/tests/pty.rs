//! Verifies the property the whole pivot rests on: a session is a *real*
//! terminal, so the agent CLI runs its full interactive TUI rather than the
//! degraded non-interactive mode it falls back to behind a pipe.
//!
//!     cargo test --test pty -- --nocapture

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "../src/pty.rs"]
mod pty;
#[path = "../src/shell_env.rs"]
mod shell_env;

use crate::pty::{PtyRegistry, PtySink};

#[derive(Default)]
struct Capture {
    out: Mutex<String>,
    exited: Mutex<bool>,
}

impl PtySink for Capture {
    fn on_output(&self, _id: &str, data: String, _seq: u64) {
        // Output is base64 now; decode so assertions still read the screen.
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.as_bytes())
            .unwrap_or_default();
        self.out
            .lock()
            .unwrap()
            .push_str(&String::from_utf8_lossy(&bytes));
    }
    fn on_exit(&self, _id: &str, _status: String) {
        *self.exited.lock().unwrap() = true;
    }
}

/// Poll until `pred` sees enough output, or give up.
fn wait_for(cap: &Arc<Capture>, timeout: Duration, pred: impl Fn(&str) -> bool) -> String {
    let deadline = Instant::now() + timeout;
    loop {
        let text = cap.out.lock().unwrap().clone();
        if pred(&text) || Instant::now() > deadline {
            return text;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn a_session_is_a_real_tty_with_the_login_shell_environment() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let env = rt.block_on(shell_env::resolve());

    assert!(
        env.resolved,
        "login-shell environment was not resolved; agents would run with a stub PATH"
    );

    let reg = PtyRegistry::new();
    let cap = Arc::new(Capture::default());

    // `sh -c` proves two things at once: stdin is a tty, and the PATH the
    // child sees is the login shell's, not this process's.
    reg.spawn(
        "t1",
        "sh",
        &[
            "-c".into(),
            "test -t 0 && printf 'IS_TTY\\n'; printf 'PATH_LEN=%s\\n' \"${#PATH}\"".into(),
        ],
        Some(&std::env::temp_dir().to_string_lossy().to_string()),
        &env,
        &[],
        100,
        30,
        cap.clone(),
    )
    .expect("spawn under pty");

    let text = wait_for(&cap, Duration::from_secs(10), |t| t.contains("PATH_LEN="));
    assert!(
        text.contains("IS_TTY"),
        "child did not see a tty on stdin — got: {text:?}"
    );

    let path_len: usize = text
        .split("PATH_LEN=")
        .nth(1)
        .and_then(|s| s.split_whitespace().next())
        .and_then(|s| s.parse().ok())
        .expect("PATH_LEN not reported");
    assert!(
        path_len > 60,
        "child PATH looks like the GUI stub ({path_len} chars); \
         version-manager shims and npx-based MCP servers would be missing"
    );

    reg.kill("t1");
}

#[test]
fn claude_starts_its_interactive_tui_under_a_pty() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let env = rt.block_on(shell_env::resolve());

    let Some(claude) = env.which("claude") else {
        eprintln!("claude not installed; skipping");
        return;
    };
    eprintln!("using {}", claude.display());

    let reg = PtyRegistry::new();
    let cap = Arc::new(Capture::default());
    let cwd = std::env::temp_dir().join("agentdesk-pty-test");
    std::fs::create_dir_all(&cwd).unwrap();

    reg.spawn(
        "t2",
        "claude",
        &[],
        Some(&cwd.to_string_lossy().to_string()),
        &env,
        &[],
        100,
        30,
        cap.clone(),
    )
    .expect("spawn claude under pty");

    // A TUI paints with escape sequences; a piped, non-interactive run would
    // not. Waiting for one is the cheapest proof the mode is right.
    let text = wait_for(&cap, Duration::from_secs(30), |t| t.contains('\u{1b}'));

    reg.kill("t2");
    let _ = std::fs::remove_dir_all(&cwd);

    assert!(
        text.contains('\u{1b}'),
        "no ANSI escapes in {} bytes of output — claude did not enter interactive mode: {:?}",
        text.len(),
        text.chars().take(400).collect::<String>()
    );
    eprintln!(
        "captured {} bytes of TUI output, first line: {:?}",
        text.len(),
        text.lines().next().unwrap_or("")
    );
}
