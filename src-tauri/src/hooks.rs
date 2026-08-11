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
    /// Where Claude Code keeps this conversation's JSONL — the one honest
    /// source of token usage. A common field of every hook payload; carried
    /// here so nobody has to reconstruct the path by guessing at claude's
    /// escaping rules.
    pub transcript_path: Option<String>,
}

pub trait HookHandler: Send + Sync + 'static {
    fn on_hook(&self, report: HookReport);
}

pub struct HookServer {
    pub port: u16,
    /// Shared secret in the URL, so another local process cannot forge status.
    pub token: String,
    pub plugin_dir: PathBuf,
    /// The accept loop. Held so shutting the desk down gives the port back
    /// rather than sitting on it: the port is part of the address held
    /// sessions were told to use, and the next run has to be able to take it.
    accept: tokio::task::AbortHandle,
}

impl HookServer {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/h/{}", self.port, self.token)
    }

    /// Stop listening and release the port.
    pub fn stop(&self) {
        self.accept.abort();
    }
}

/// Where the port and token are kept between runs. See `start`.
const ENDPOINT_FILE: &str = "hook-endpoint";

/// The endpoint the last run used, if it is still readable and sane.
///
/// The token is checked, not merely read. It goes straight into a URL path,
/// so a file that has been edited by hand — or truncated by a full disk —
/// must not be able to smuggle a second path segment into the route.
fn remembered(data_dir: &Path) -> (Option<u16>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(data_dir.join(ENDPOINT_FILE)) else {
        return (None, None);
    };
    let mut lines = text.lines();
    let port = lines.next().and_then(|s| s.trim().parse::<u16>().ok());
    let token = lines
        .next()
        .map(str::trim)
        .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(str::to_string);
    (port, token)
}

/// Write the endpoint down for the next run.
///
/// The token is the only thing between another local process and the ability
/// to forge status for a session, so it is written the way a key is written.
/// The mode is asked for at creation *and* set afterwards: `mode()` is
/// ignored when the file already exists, and a chmod that follows the write
/// leaves a window where the secret is readable — a secret is only as good as
/// its narrowest moment.
fn remember(data_dir: &Path, port: u16, token: &str) -> Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let path = data_dir.join(ENDPOINT_FILE);
    let body = format!("{port}\n{token}\n");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?;
        f.write_all(body.as_bytes())?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, body)?;
    Ok(())
}

/// Take last run's port if it is still free, otherwise any port.
///
/// Briefly patient about it. The commonest reason the old port is busy is the
/// previous instance still letting go of it — a relaunch, or an upgrade
/// restarting the app — and giving up on the first refusal would silence
/// every session that instance left running, for the sake of a fifth of a
/// second.
async fn bind_preferring(port: Option<u16>) -> Result<TcpListener> {
    if let Some(p) = port.filter(|p| *p != 0) {
        let mut last = None;
        for _ in 0..10 {
            match TcpListener::bind(("127.0.0.1", p)).await {
                Ok(l) => return Ok(l),
                Err(e) => last = Some(e),
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        if let Some(e) = last {
            // Somebody else has it for good: a second AgentDesk install, or an
            // unrelated program. Taking a fresh port loses the reports from
            // sessions the previous run left running, which is exactly where
            // this was before any of it was remembered — so it degrades to the
            // old behaviour rather than refusing to start.
            eprintln!("[hooks] port {p} is taken ({e}); sessions held by the last run will stay quiet");
        }
    }
    Ok(TcpListener::bind("127.0.0.1:0").await?)
}

/// Bind a loopback listener and write the companion plugin.
///
/// **The endpoint is the same one as last time, when it can be.** A session
/// tmux held through a restart is still running, but the URL it reports to
/// was baked into `hooks.json` when the session started, and Claude Code
/// reads that file once. Both halves of that URL used to be fresh every run —
/// an ephemeral port and a new uuid — so a held agent kept posting into
/// nothing: it ran on, and the desk went blind to it for the rest of its
/// life. Remembering the pair is not a second channel; it is the existing one
/// made to survive the thing it was already meant to survive.
pub async fn start(data_dir: &Path, handler: Arc<dyn HookHandler>) -> Result<HookServer> {
    let (kept_port, kept_token) = remembered(data_dir);
    let listener = bind_preferring(kept_port)
        .await
        .context("binding the hook listener")?;
    let port = listener.local_addr()?.port();
    let token = kept_token.unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    if let Err(e) = remember(data_dir, port, &token) {
        // Not fatal: this run works either way. Only the *next* one loses the
        // sessions this one leaves behind.
        eprintln!("[hooks] could not remember the endpoint: {e}");
    }

    let plugin_dir = data_dir.join("plugin");
    let url = format!("http://127.0.0.1:{port}/h/{token}");
    write_plugin(&plugin_dir, &url).context("writing the status plugin")?;

    let want = format!("/h/{token}");
    let accept = tokio::spawn(async move {
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
    })
    .abort_handle();

    eprintln!("[hooks] listening on 127.0.0.1:{port}, plugin at {}", plugin_dir.display());
    Ok(HookServer {
        port,
        token,
        plugin_dir,
        accept,
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

    let payload = serde_json::from_slice::<serde_json::Value>(&body).ok();
    let activity = payload.as_ref().and_then(activity_from_payload);
    let transcript_path = payload
        .as_ref()
        .and_then(|v| v.get("transcript_path"))
        .and_then(|v| v.as_str())
        .map(String::from);

    Some(HookReport {
        session_id: session_id?,
        state: state?,
        activity,
        transcript_path,
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

    // A message to another session names two things a human would ask for —
    // whom, and what — where everything below is a single argument.
    if tool == "SendMessage" {
        let to = pick("to").unwrap_or_default();
        let what = pick("summary")
            .or_else(|| pick("message"))
            .unwrap_or_default();
        let detail: String = if to.is_empty() {
            what
        } else {
            format!("→ {to}: {what}").chars().take(160).collect()
        };
        return Some(Activity { tool, detail });
    }

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

/// The plugin as files, for provisioning into a host that cannot see our
/// disk: an SSH host gets these written into its own filesystem, with a URL
/// that points back through the reverse tunnel.
pub fn plugin_files(url: &str) -> Vec<(&'static str, String)> {
    let manifest = serde_json::json!({
        "name": "agentdesk-status",
        "version": env!("CARGO_PKG_VERSION"),
        "description": "Reports session status to the AgentDesk window. Adds no tools and changes no behaviour."
    });
    vec![
        (
            ".claude-plugin/plugin.json",
            serde_json::to_string_pretty(&manifest).unwrap_or_default(),
        ),
        (
            "hooks/hooks.json",
            serde_json::to_string_pretty(&hooks_json(url)).unwrap_or_default(),
        ),
    ]
}

/// Write (or refresh) the plugin so an app upgrade updates the hooks too.
///
/// The URL is baked in here rather than read at hook time because most of
/// these are `http` hooks, whose `url` is a literal string with no shell
/// behind it to resolve anything. That is why `start` goes to the trouble of
/// keeping the same URL across runs: for a session that is already running,
/// this file is a photograph, not a pointer.
fn write_plugin(dir: &Path, url: &str) -> Result<()> {
    for (rel, contents) in plugin_files(url) {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, contents)?;
    }
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

    /// The remembered token is the path segment of the route, so a file that
    /// has been hand-edited, half-written, or filled with someone else's idea
    /// of a good time must not be able to add a segment of its own. A rejected
    /// token costs one run's worth of held sessions; an accepted bad one
    /// changes what the server is listening for.
    #[test]
    fn a_remembered_token_that_is_not_a_token_is_refused() {
        let dir = std::env::temp_dir().join(format!("agentdesk-hooks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        for bad in [
            "9000\n../../h/other\n",     // a second path segment
            "9000\nabc def\n",           // a space, which would split the request line
            "9000\n\n",                  // empty
            "9000\ntok?state=idle\n",    // a query of its own
        ] {
            std::fs::write(dir.join(ENDPOINT_FILE), bad).unwrap();
            let (_, token) = remembered(&dir);
            assert!(token.is_none(), "accepted {bad:?} as a token");
        }

        // The two halves are independent, and only one of them is a secret.
        // An unreadable port with a good token keeps the token and takes a
        // fresh port: that loses the sessions the last run held, which is a
        // cost, where reusing a token nobody can vouch for is a hazard.
        std::fs::write(dir.join(ENDPOINT_FILE), "not-a-port\ncafef00d\n").unwrap();
        assert_eq!(remembered(&dir), (None, Some("cafef00d".to_string())));

        // And the round trip it is actually for.
        remember(&dir, 41234, "cafef00d").unwrap();
        assert_eq!(remembered(&dir), (Some(41234), Some("cafef00d".to_string())));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(ENDPOINT_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "the token is readable by other users");
        }
        let _ = std::fs::remove_dir_all(&dir);
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

    /// A cross-session message is the one tool call whose interesting
    /// argument is two arguments: whom, and what. The timeline showing
    /// 「→ 修好登入 #1: schema 改了」 is how coordination between cards
    /// stays legible without opening either terminal.
    #[test]
    fn a_message_to_another_session_names_the_receiver_and_the_gist() {
        let a = activity_from_payload(&json!({
            "tool_name": "SendMessage",
            "tool_input": { "to": "修好登入 #1", "message": "schema 改了，tenant_id 上了 main",
                            "summary": "schema 改了" }
        }))
        .unwrap();
        assert_eq!(a.tool, "SendMessage");
        assert_eq!(a.detail, "→ 修好登入 #1: schema 改了");

        // Without a summary the message itself is the gist.
        let b = activity_from_payload(&json!({
            "tool_name": "SendMessage",
            "tool_input": { "to": "payments", "message": "migration finished" }
        }))
        .unwrap();
        assert_eq!(b.detail, "→ payments: migration finished");
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
