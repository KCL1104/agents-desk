//! Preconditions shared by the tests that drive a real `claude`.
//!
//! Lives under `tests/common/` rather than `tests/` because Cargo builds every
//! top-level file in `tests/` as its own test binary, and this one holds no
//! tests.

/// Whether the installed `claude` can open a session without a human present.
///
/// Being on `PATH` is not enough, and checking only that is what made these
/// tests fail on machines where nobody had ever signed in: the CLI comes up on
/// its welcome flow, never starts a session, and so never fires `SessionStart`
/// or accepts a prompt. The test then spends its full timeout proving only that
/// this machine has no login — a red suite that says nothing about the code.
///
/// Claude Code records finishing that flow as `hasCompletedOnboarding` in
/// `~/.claude.json`, so that is what is asked. Note this is another product's
/// private file: if the key ever moves, these tests start skipping rather than
/// start passing wrongly, and the skip says so on stderr.
///
/// Set `AGENTDESK_TEST_ASSUME_CLAUDE=1` to override and run them anyway.
pub fn claude_is_signed_in() -> bool {
    if std::env::var("AGENTDESK_TEST_ASSUME_CLAUDE").is_ok_and(|v| !v.is_empty() && v != "0") {
        return true;
    }
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(home.join(".claude.json")) else {
        return false;
    };
    let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    cfg.get("hasCompletedOnboarding")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false)
}

/// Skips the calling test unless a real, signed-in `claude` is available.
///
/// Returns false when the caller should return early. Takes the resolved
/// `which` result rather than a `ShellEnv`, because each test binary compiles
/// its own copy of that module and there is no shared type to name here.
pub fn require_claude(found_on_path: bool) -> bool {
    if !found_on_path {
        eprintln!("claude not installed; skipping");
        return false;
    }
    if !claude_is_signed_in() {
        eprintln!(
            "claude is installed but not signed in — it would sit on its welcome \
             screen and never start a session; skipping. \
             Set AGENTDESK_TEST_ASSUME_CLAUDE=1 to run it anyway."
        );
        return false;
    }
    true
}
