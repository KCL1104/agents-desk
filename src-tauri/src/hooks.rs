//! Session status via Claude Code hooks.
//!
//! The app needs to know when a session is waiting for you, and what it is
//! doing while it is not — that is what makes several agents at once
//! manageable. Scraping the terminal for it would mean parsing ANSI and would
//! break the next time the TUI changes, so instead we ask Claude Code to
//! tell us.
//!
//! Three decisions here were settled by measurement, not by documentation:
//!
//!   * Hooks ship as a **plugin** loaded with `--plugin-dir`, not via
//!     `--settings`. `--settings` overrides same-named keys, so injecting a
//!     `hooks` key there would silently disable the user's own hooks.
//!   * Most events use the **`http`** hook type: no subprocess per tool call,
//!     and the request body carries the full payload including `tool_name`
//!     and `tool_input`. Session identity rides in a header, expanded from
//!     `AGENTDESK_SESSION_ID` via `allowedEnvVars`.
//!   * **`SessionStart` is the exception** — an `http` hook on it never
//!     fires, while a `command` hook does. It runs once per session, so the
//!     one subprocess costs nothing.
//!
//! A `command` hook must always exit 0: a non-zero exit *blocks* the action it
//! fired on, so a stopped app must never be able to wedge a session.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Longest hook body we will read into memory. A `Write` tool's input can
/// carry a whole file; we only need the head of it, but the rest still has to
/// be drained so the sender never blocks.
const MAX_BODY: usize = 64 * 1024;

/// What a hook tells us about a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookState {
    Started,
    Running,
    WaitingPermission,
    WaitingInput,
    Idle,
    Ended,
}

impl HookState {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "started" => Self::Started,
            "running" => Self::Running,
            "waiting_permission" => Self::WaitingPermission,
            "waiting_input" => Self::WaitingInput,
            "idle" => Self::Idle,
            "ended" => Self::Ended,
            _ => return None,
        })
    }
}

/// What the agent is doing right now, for the session list and overview.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Activity {
    pub tool: String,
    /// The interesting argument: a command line, a path, a pattern.
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct HookReport {
    pub session_id: String,
    pub state: HookState,
    pub activity: Option<Activity>,
}

pub trait HookHandler: Send + Sync + 'static {
    fn on_hook(&self, report: HookReport);
}

pub struct HookServer {
    pub port: u16,
    /// Shared secret in the URL, so another local process cannot forge status.
    pub token: String,
    pub plugin_dir: PathBuf,
}

impl HookServer {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/h/{}", self.port, self.token)
    }
}

/// Bind a loopback listener and write the companion plugin.
pub async fn start(data_dir: &Path, handler: Arc<dyn HookHandler>) -> Result<HookServer> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .context("binding the hook listener")?;
    let port = listener.local_addr()?.port();
    let token = uuid::Uuid::new_v4().simple().to_string();

    let plugin_dir = data_dir.join("plugin");
    let url = format!("http://127.0.0.1:{port}/h/{token}");
    write_plugin(&plugin_dir, &url).context("writing the status plugin")?;

    let want = format!("/h/{token}");
    tokio::spawn(async move {
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(pair) => pair,
                Err(e) => {
                    eprintln!("[hooks] accept failed: {e}");
                    continue;
                }
            };
            let handler = Arc::clone(&handler);
            let want = want.clone();
            tokio::spawn(async move { serve(stream, &want, handler).await });
        }
    });

    eprintln!("[hooks] listening on 127.0.0.1:{port}, plugin at {}", plugin_dir.display());
    Ok(HookServer {
        port,
        token,
        plugin_dir,
    })
}

/// Handle one request.
///
/// Hand-rolled rather than a web framework: there is one route, the only
/// clients are Claude Code's own hook runner and our `curl` one-liner, and the
/// reply is always the same. Every request is answered 200 so a hook never
/// fails and never blocks the agent.
async fn serve(mut stream: tokio::net::TcpStream, want_prefix: &str, handler: Arc<dyn HookHandler>) {
    if let Some(report) = read_request(&mut stream, want_prefix).await {
        handler.on_hook(report);
    }
    let _ = stream
        .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
        .await;
    let _ = stream.shutdown().await;
}

async fn read_request(
    stream: &mut tokio::net::TcpStream,
    want_prefix: &str,
) -> Option<HookReport> {
    // Read until the headers are complete.
    let mut buf = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 8 * 1024];
    let head_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > MAX_BODY {
            return None;
        }
    };

    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.lines();
    let target = lines.next()?.split_whitespace().nth(1)?.to_string();
    if !target.starts_with(want_prefix) {
        return None;
    }

    // Session id arrives in a header from `http` hooks and in the query from
    // the `command` hook that covers SessionStart.
    let mut session_id: Option<String> = None;
    let mut content_length = 0usize;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "x-agentdesk-session" => session_id = Some(value.to_string()),
            "content-length" => content_length = value.parse().unwrap_or(0),
            _ => {}
        }
    }

    let mut state = None;
    if let Some(query) = target.split_once('?').map(|(_, q)| q) {
        for pair in query.split('&') {
            match pair.split_once('=') {
                Some(("sid", v)) if !v.is_empty() => session_id.get_or_insert(v.to_string()),
                Some(("state", v)) => {
                    state = HookState::parse(v);
                    continue;
                }
                _ => continue,
            };
        }
    }

    // Drain the body fully — a sender blocked on a half-read body would stall
    // the agent — but only keep the head of it for parsing.
    //
    // Bytes received and bytes kept are counted separately on purpose. Using
    // the kept length as the loop condition deadlocks once it is clamped at
    // the cap: it stops growing, the condition stays true, and the read waits
    // forever for data the sender already finished writing.
    let mut body = buf.split_off(head_end + 4);
    let mut received = body.len();
    while received < content_length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        received += n;
        if body.len() < MAX_BODY {
            let take = (MAX_BODY - body.len()).min(n);
            body.extend_from_slice(&chunk[..take]);
        }
    }

    let activity = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| activity_from_payload(&v));

    Some(HookReport {
        session_id: session_id?,
        state: state?,
        activity,
    })
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

/// Turn a `PreToolUse` payload into a one-line description of the work.
fn activity_from_payload(v: &serde_json::Value) -> Option<Activity> {
    let tool = v.get("tool_name")?.as_str()?.to_string();
    let input = v.get("tool_input");

    let pick = |key: &str| -> Option<String> {
        input?
            .get(key)?
            .as_str()
            .map(|s| s.chars().take(160).collect())
    };

    // The argument a human would name the action by, per tool.
    let detail = pick("command")
        .or_else(|| pick("file_path"))
        .or_else(|| pick("path"))
        .or_else(|| pick("pattern"))
        .or_else(|| pick("url"))
        .or_else(|| pick("description"))
        .or_else(|| pick("query"))
        .unwrap_or_default();

    Some(Activity { tool, detail })
}

/* ------------------------------------------------------------------ */
/* Plugin generation                                                   */
/* ------------------------------------------------------------------ */

/// An `http` hook: Claude Code posts it itself, so there is no subprocess per
/// tool call and the body carries the full payload.
fn http_reporter(url: &str, state: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "http",
        "url": format!("{url}?state={state}"),
        "headers": { "X-AgentDesk-Session": "$AGENTDESK_SESSION_ID" },
        "allowedEnvVars": ["AGENTDESK_SESSION_ID"],
        // Short: an unreachable listener should cost the agent no more than a
        // blink, and a refused connection fails instantly anyway.
        "timeout": 2
    })
}

/// A `command` hook, for the one event an `http` hook never fires on.
///
/// `--max-time` bounds a hung listener; `|| true` forces exit 0, because a
/// hook exiting non-zero blocks the action it fired on.
fn command_reporter(url: &str, state: &str) -> serde_json::Value {
    let cmd = format!(
        "curl -sS --max-time 2 -X POST \
         \"{url}?sid=$AGENTDESK_SESSION_ID&state={state}\" -o /dev/null || true"
    );
    serde_json::json!({
        "type": "command",
        "command": cmd,
        // `shell` is deliberately unset. Setting it to "sh" makes Claude Code
        // skip the hook silently — no error, no report, nothing to debug from.
        // ("bash" works, as does omitting the field.) Measured, not documented.
        "async": true,
        "timeout": 5
    })
}

fn hooks_json(url: &str) -> serde_json::Value {
    serde_json::json!({
        "hooks": {
            // Measured: an `http` hook on SessionStart never fires; a
            // `command` hook does. It runs once per session either way.
            "SessionStart":     [{ "hooks": [command_reporter(url, "started")] }],
            "UserPromptSubmit": [{ "hooks": [http_reporter(url, "running")] }],
            // The one that carries what the agent is actually doing.
            "PreToolUse":       [{ "matcher": "*", "hooks": [http_reporter(url, "running")] }],
            // The two that matter most: the agent cannot continue without you.
            "PermissionRequest": [{ "matcher": "*", "hooks": [http_reporter(url, "waiting_permission")] }],
            "Notification": [
                { "matcher": "permission_prompt", "hooks": [http_reporter(url, "waiting_permission")] },
                { "matcher": "idle_prompt",       "hooks": [http_reporter(url, "waiting_input")] }
            ],
            "Stop":       [{ "hooks": [http_reporter(url, "idle")] }],
            "SessionEnd": [{ "hooks": [http_reporter(url, "ended")] }]
        }
    })
}

/// Write (or refresh) the plugin so an app upgrade updates the hooks too.
///
/// The listener port changes every run, so the URL is baked in at startup
/// rather than read from the environment at hook time.
fn write_plugin(dir: &Path, url: &str) -> Result<()> {
    let manifest_dir = dir.join(".claude-plugin");
    let hooks_dir = dir.join("hooks");
    std::fs::create_dir_all(&manifest_dir)?;
    std::fs::create_dir_all(&hooks_dir)?;

    let manifest = serde_json::json!({
        "name": "agentdesk-status",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Reports session status to the AgentDesk window. Adds no tools and changes no behaviour."
    });
    std::fs::write(
        manifest_dir.join("plugin.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    std::fs::write(
        hooks_dir.join("hooks.json"),
        serde_json::to_string_pretty(&hooks_json(url))?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const URL: &str = "http://127.0.0.1:1234/h/tok";

    fn all_hooks() -> Vec<serde_json::Value> {
        let hooks = hooks_json(URL);
        let mut out = Vec::new();
        for (_event, entries) in hooks["hooks"].as_object().unwrap() {
            for entry in entries.as_array().unwrap() {
                for hook in entry["hooks"].as_array().unwrap() {
                    out.push(hook.clone());
                }
            }
        }
        out
    }

    #[test]
    fn session_start_uses_a_command_hook_because_http_never_fires_on_it() {
        let hooks = hooks_json(URL);
        let start = &hooks["hooks"]["SessionStart"][0]["hooks"][0];
        assert_eq!(start["type"], "command", "measured: http on SessionStart is silently dropped");
        // Every other event is cheaper as http.
        for event in ["PreToolUse", "Stop", "Notification", "SessionEnd"] {
            let first = &hooks["hooks"][event][0]["hooks"][0];
            assert_eq!(first["type"], "http", "{event} should not spawn a process per call");
        }
    }

    #[test]
    fn http_hooks_carry_the_session_id_and_allow_its_expansion() {
        for hook in all_hooks().iter().filter(|h| h["type"] == "http") {
            assert_eq!(hook["headers"]["X-AgentDesk-Session"], "$AGENTDESK_SESSION_ID");
            // Without the allowlist the header is sent literally and every
            // report lands on a session that does not exist.
            let allowed = hook["allowedEnvVars"].as_array().unwrap();
            assert!(allowed.iter().any(|v| v == "AGENTDESK_SESSION_ID"));
        }
    }

    #[test]
    fn command_hooks_cannot_block_the_agent() {
        for hook in all_hooks().iter().filter(|h| h["type"] == "command") {
            let cmd = hook["command"].as_str().unwrap();
            assert!(cmd.ends_with("|| true"), "a non-zero exit blocks the action: {cmd}");
            assert!(cmd.contains("--max-time"), "unbounded curl: {cmd}");
            match hook.get("shell").and_then(|v| v.as_str()) {
                None | Some("bash") => {}
                Some(other) => panic!("`shell: {other}` is not known to fire"),
            }
        }
    }

    #[test]
    fn every_state_the_plugin_emits_is_one_the_server_understands() {
        for hook in all_hooks() {
            let text = hook["url"]
                .as_str()
                .map(String::from)
                .or_else(|| hook["command"].as_str().map(String::from))
                .unwrap();
            let state = text
                .split("state=")
                .nth(1)
                .and_then(|s| s.split(['&', '"', ' ']).next())
                .expect("carries a state");
            assert!(
                HookState::parse(state).is_some(),
                "plugin emits `{state}`, which the server would drop"
            );
        }
    }

    #[test]
    fn activity_names_the_argument_a_human_would_use() {
        let bash = activity_from_payload(&json!({
            "tool_name": "Bash",
            "tool_input": { "command": "pytest tests/test_auth.py -v", "description": "Run tests" }
        }))
        .unwrap();
        assert_eq!(bash.tool, "Bash");
        // The command itself, not the model's prose description of it.
        assert_eq!(bash.detail, "pytest tests/test_auth.py -v");

        let edit = activity_from_payload(&json!({
            "tool_name": "Edit",
            "tool_input": { "file_path": "/repo/src/auth.py", "old_string": "a", "new_string": "b" }
        }))
        .unwrap();
        assert_eq!(edit.detail, "/repo/src/auth.py");

        let grep = activity_from_payload(&json!({
            "tool_name": "Grep", "tool_input": { "pattern": "TODO" }
        }))
        .unwrap();
        assert_eq!(grep.detail, "TODO");
    }

    #[test]
    fn a_tool_with_no_recognizable_argument_still_reports_its_name() {
        let a = activity_from_payload(&json!({ "tool_name": "TodoWrite", "tool_input": {} })).unwrap();
        assert_eq!(a.tool, "TodoWrite");
        assert!(a.detail.is_empty());
    }

    #[test]
    fn a_payload_that_is_not_a_tool_call_yields_no_activity() {
        // Stop and Notification bodies have no tool_name; they must not
        // overwrite the last real activity with an empty one.
        assert!(activity_from_payload(&json!({ "hook_event_name": "Stop" })).is_none());
    }

    #[test]
    fn oversized_detail_is_truncated_rather_than_carried_whole() {
        let long = "x".repeat(5000);
        let a = activity_from_payload(&json!({
            "tool_name": "Bash", "tool_input": { "command": long }
        }))
        .unwrap();
        assert_eq!(a.detail.chars().count(), 160);
    }

    #[test]
    fn writes_a_plugin_claude_code_can_load() {
        let dir = std::env::temp_dir().join(format!("agentdesk-plugin-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write_plugin(&dir, URL).unwrap();

        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude-plugin/plugin.json")).unwrap())
                .unwrap();
        assert_eq!(manifest["name"], "agentdesk-status");

        let hooks: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("hooks/hooks.json")).unwrap())
                .unwrap();
        assert!(hooks["hooks"]["Stop"].is_array());
        // The listener port changes every run, so the URL must be baked in.
        assert!(hooks["hooks"]["Stop"][0]["hooks"][0]["url"]
            .as_str()
            .unwrap()
            .starts_with(URL));

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
