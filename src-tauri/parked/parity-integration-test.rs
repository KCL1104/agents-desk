//! End-to-end integration test across the whole stack:
//! Rust core -> Node sidecar -> Agent SDK -> real `claude` process.
//!
//! Asserts the property the whole app rests on: a session opened by
//! Marol loads the same project configuration a terminal session would.
//!
//! Costs a real (small) API call, so it is ignored by default:
//!
//!     cargo test --test parity -- --ignored --nocapture

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[path = "../src/core.rs"]
mod core;
#[path = "../src/protocol.rs"]
mod protocol;
#[path = "../src/rules.rs"]
mod rules;
#[path = "../src/shell_env.rs"]
mod shell_env;
#[path = "../src/sidecar.rs"]
mod sidecar;

use crate::core::{Core, UiSink};

/// Captures everything the core emits so the test can assert on it.
struct Collector(Mutex<mpsc::Sender<(String, serde_json::Value)>>);

impl UiSink for Collector {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.0.lock().unwrap().send((event.to_string(), payload));
    }
}

/// Build a throwaway project with a CLAUDE.md and a project-scoped skill.
fn fixture() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("marol-parity-{}", std::process::id()));
    let skill = dir.join(".claude/skills/parity-probe");
    std::fs::create_dir_all(&skill).expect("mkdir fixture");
    std::fs::write(dir.join("CLAUDE.md"), "Project marker: MAROL_PARITY_OK\n").unwrap();
    std::fs::write(dir.join("NOTE.md"), "The secret word is PANGOLIN.\n").unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: parity-probe\ndescription: Probe skill proving project skills load.\n---\nLoaded from the project.\n",
    )
    .unwrap();
    dir
}

#[test]
#[ignore = "spawns a real claude session and makes a billable API call"]
fn session_loads_the_same_config_a_terminal_would() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let dir = fixture();

    let (tx, rx) = mpsc::channel();
    let sink: Arc<dyn UiSink> = Arc::new(Collector(Mutex::new(tx)));

    let core = rt
        .block_on(Core::start(sink))
        .expect("core failed to start — is the sidecar built and node on PATH?");

    assert!(
        core.env.resolved,
        "login-shell environment was not resolved; agents would run with a stub PATH"
    );
    assert!(
        core.env.which("claude").is_some(),
        "`claude` not found on the login-shell PATH"
    );

    core.new_session(
        dir.to_string_lossy().to_string(),
        Some("Reply with exactly the word READY and nothing else.".into()),
        None,
    )
    .expect("new_session");

    // Drain events until the session reports what it loaded.
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    let mut init: Option<serde_json::Value> = None;
    while std::time::Instant::now() < deadline {
        let Ok((event, payload)) = rx.recv_timeout(Duration::from_secs(5)) else {
            continue;
        };
        if event != "session:event" {
            continue;
        }
        let ev = &payload["ev"];
        if ev["kind"] == "init" {
            init = Some(ev.clone());
            break;
        }
    }

    let init = init.expect("no init event within 120s");
    println!("init: {}", serde_json::to_string_pretty(&init).unwrap());

    let skills: Vec<String> = init["skills"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    assert!(
        skills.iter().any(|s| s == "parity-probe"),
        "project skill did not load — terminal parity is broken. Loaded: {skills:?}"
    );
    assert!(
        init["tools"].as_array().map(|a| a.len()).unwrap_or(0) > 5,
        "expected the standard tool set to be present"
    );
    assert!(
        !init["model"].as_str().unwrap_or("").is_empty(),
        "no model reported"
    );

    core.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}
