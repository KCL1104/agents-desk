//! Transport-agnostic application core.
//!
//! A session is a real terminal running a real agent CLI. The core owns the
//! PTYs, the session list, its persistence, and the hook-reported status; it
//! knows nothing about Tauri and talks to the outside world through `UiSink`,
//! so the same core can later be driven by an axum websocket without being
//! rewritten.

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::config;
use crate::hooks::{self, Activity, HookHandler, HookReport, HookServer, HookState};
use crate::host::{self, Host, HostRef};
use crate::prompt::{self, Delivery};
use crate::pty::{self as pty, PtyRegistry, PtySink};
use crate::shell_env::{self, ShellEnv};
use crate::store::{
    Lifecycle, Outcome, PermissionMode, Profile, Store, StoredAttempt, StoredSession, StoredTab,
    StoredTask,
};
use crate::worktree::{self, Worktrees};

pub trait UiSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: serde_json::Value);
}

/// A new tab lets the window width decide how many columns to draw.
///
/// The core never interprets this string — arranging panes is entirely the
/// frontend's business, and a stored grid size is meaningless here. It is
/// spelled out rather than left empty only so a fresh tab round-trips through
/// the database as something the frontend recognises.
const DEFAULT_LAYOUT: &str = r#"{"mode":"auto","cols":"auto"}"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Saved, with no terminal attached right now.
    Saved,
    /// Still running, with nobody watching.
    ///
    /// Only reachable in a world that holds sessions: the app was closed,
    /// tmux kept the agent, and this start found it alive. Distinct from
    /// `Saved` because they are opposite facts — one says the work ended,
    /// the other says it did not — and a card that says "closed" over a
    /// running agent invites a second one onto the same worktree.
    ///
    /// Not `live`: no pty in *this* process is carrying it yet. Opening the
    /// session attaches to what is already there.
    Detached,
    /// Terminal is up; the agent has not reported anything yet.
    Starting,
    /// Sitting on Claude Code's folder-trust prompt.
    ///
    /// Every attempt opens a worktree Claude Code has never seen, so every
    /// attempt starts here. No hook can report it: nothing runs until the
    /// prompt is answered, `SessionStart` included. Measured — see
    /// `tests/prompt_injection.rs`.
    ///
    /// So the core sets it directly, which it can do honestly because it
    /// created the directory a moment earlier and knows this is its first
    /// launch. Without it the badge would miss the one state every new
    /// attempt begins in, and an auto-started queued attempt would look like
    /// it was running while it sat waiting for a keystroke.
    AwaitingTrust,
    /// The agent is working.
    Running,
    /// Blocked on a permission decision — it cannot continue without you.
    WaitingPermission,
    /// Idle long enough that Claude Code raised an idle prompt.
    WaitingInput,
    /// Finished its turn; your move.
    Idle,
    Exited,
}

impl Status {
    /// Whether this state means a human is being waited on.
    pub fn needs_you(self) -> bool {
        matches!(
            self,
            Status::WaitingPermission | Status::WaitingInput | Status::AwaitingTrust
        )
    }

    fn from_hook(state: HookState) -> Self {
        match state {
            HookState::Started => Status::Running,
            HookState::Running => Status::Running,
            HookState::WaitingPermission => Status::WaitingPermission,
            HookState::WaitingInput => Status::WaitingInput,
            HookState::Idle => Status::Idle,
            HookState::Ended => Status::Exited,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionMeta {
    pub id: String,
    pub cwd: String,
    pub title: String,
    /// Which agent CLI this session runs: `claude`, `codex`, ...
    pub agent: String,
    pub status: Status,
    pub created_at: u64,
    pub last_active_at: u64,
    pub live: bool,
    /// True once the status plugin has reported at least once, so the UI can
    /// distinguish "idle" from "this CLI does not report status".
    pub reports_status: bool,
    /// What the agent is doing right now, from the last `PreToolUse` report.
    pub activity: Option<Activity>,
    /// When that activity started, for an elapsed counter.
    pub activity_since: u64,
    /// Marked done by the user. Completion is a human judgement — an agent
    /// session never reports it, because `Stop` means "this turn ended", not
    /// "the work is finished".
    pub completed: bool,
    /// The attempt this session is running, or `None` for an ad-hoc session
    /// that lives outside the board.
    pub attempt_id: Option<String>,
    /// A message is queued to go in when this turn ends. Transient, like
    /// the PTY it waits on — never stored, false on every restore.
    pub has_followup: bool,
    /// The `$AGENTDESK_PORT` a run script was handed, when the app can
    /// reach it (local and WSL; an SSH host's port lives on the remote).
    /// Transient like the followup flag: the server dies with the PTY, and
    /// a persisted port would be a column that lies after every restart.
    pub preview_port: Option<u16>,
    /// The conversation's token account, read off its transcript at each
    /// turn's end. In-memory: the transcript is the durable record, and a
    /// recompute is one read away.
    pub usage: Option<Usage>,
    /// Where that transcript lives, as the hook payload names it. Not
    /// serialized — a host-side path is plumbing, not something the UI
    /// renders.
    #[serde(skip)]
    pub transcript_path: Option<String>,
}

/// A session's token account. `context` is the last main-line request's
/// prompt size — where the next turn starts from; the other four are
/// cumulative across the conversation, sidechains included, because a
/// sub-agent's spend is real spend.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub context: u64,
}

/// One session's progress through its transcript.
#[derive(Debug, Clone, Copy, Default)]
struct UsageState {
    /// Bytes already consumed — always at a line boundary.
    offset: u64,
    acc: Usage,
}

/// Sum the usage in a stretch of transcript JSONL.
///
/// Returns the totals of every assistant row in the text, and the context
/// size of the last **main-line** one (`input + cache_read + cache_write`
/// ≈ the prompt the next turn will grow from). Sidechain rows count toward
/// the totals — their spend is real — but never set the context: a
/// sub-agent's prompt belongs to its own conversation. Rows that fail to
/// parse are skipped, not fatal: one malformed line must not zero a
/// session's account.
fn parse_usage(text: &str) -> (Usage, Option<u64>) {
    let mut sum = Usage::default();
    let mut context = None;
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(u) = v.get("message").and_then(|m| m.get("usage")) else {
            continue;
        };
        let g = |k: &str| u.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let (i, o, cr, cw) = (
            g("input_tokens"),
            g("output_tokens"),
            g("cache_read_input_tokens"),
            g("cache_creation_input_tokens"),
        );
        sum.input += i;
        sum.output += o;
        sum.cache_read += cr;
        sum.cache_write += cw;
        if v.get("isSidechain").and_then(|x| x.as_bool()) != Some(true) {
            context = Some(i + cr + cw);
        }
    }
    (sum, context)
}

impl SessionMeta {
    fn to_stored(&self) -> StoredSession {
        StoredSession {
            id: self.id.clone(),
            cwd: self.cwd.clone(),
            title: self.title.clone(),
            agent: self.agent.clone(),
            created_at: self.created_at,
            last_active_at: self.last_active_at,
            archived: false,
            completed: self.completed,
            attempt_id: self.attempt_id.clone(),
        }
    }

    fn from_stored(s: StoredSession) -> Self {
        Self {
            id: s.id,
            cwd: s.cwd,
            title: s.title,
            agent: s.agent,
            status: Status::Saved,
            created_at: s.created_at,
            last_active_at: s.last_active_at,
            live: false,
            reports_status: false,
            activity: None,
            activity_since: 0,
            completed: s.completed,
            attempt_id: s.attempt_id,
            has_followup: false,
            preview_port: None,
            usage: None,
            transcript_path: None,
        }
    }
}

/// Whether a status change is worth a line on the timeline.
///
/// `running` and `starting` are not: a run of tool calls already says the
/// agent was working, and a status line between each of them would bury them.
fn timeline_worthy(s: Status) -> bool {
    matches!(
        s,
        Status::WaitingPermission | Status::WaitingInput | Status::Idle | Status::Exited
    )
}

fn status_name(s: Status) -> &'static str {
    match s {
        Status::Saved => "saved",
        Status::Detached => "detached",
        Status::Starting => "starting",
        Status::AwaitingTrust => "awaiting_trust",
        Status::Running => "running",
        Status::WaitingPermission => "waiting_permission",
        Status::WaitingInput => "waiting_input",
        Status::Idle => "idle",
        Status::Exited => "exited",
    }
}

/// Assemble a command line: options first, the prompt last.
///
/// Kept apart from spawning because the ordering is the whole point and it is
/// easy to undo by accident. A positional argument sitting in front of an
/// option leaves the parse to whatever the CLI happens to do with it, and the
/// symptom — a session that starts and then does nothing — looks like a dozen
/// other problems.
fn build_args(
    agent: &str,
    opts: Vec<String>,
    plugin_dir: Option<&str>,
    positional: Option<String>,
) -> Vec<String> {
    let mut args = opts;
    // Only Claude Code understands `--plugin-dir`; other CLIs run without
    // status reporting rather than failing to start.
    if let (Some(dir), "claude") = (plugin_dir, agent) {
        args.push("--plugin-dir".to_string());
        args.push(dir.to_string());
    }
    if let Some(p) = positional {
        args.push(p);
    }
    args
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The CLIs whose names the dialogs always offer, profile or no profile.
///
/// A profile may not take one of these names: "claude" meaning something
/// other than `claude` is exactly the confusion names exist to prevent.
pub const BARE_AGENTS: [&str; 4] = ["claude", "codex", "gemini", "aider"];

/// One entry in a launch dialog's list: a bare agent, or a named profile.
#[derive(Debug, Clone, Serialize)]
pub struct Launcher {
    /// What the person picks — a bare agent's own name, or a profile's.
    pub name: String,
    /// The CLI it resolves to, so the dialog knows which conventions apply
    /// (prompt delivery, permission modes) without resolving anything itself.
    pub agent: String,
    /// True for a profile, so the list can say which entries are yours.
    pub profile: bool,
}

/// One instruction file an agent working in a directory will read.
///
/// `exists` is the honest half: a rules file that is not there is still worth
/// naming, because the question people actually have is "where does this go",
/// and an empty list answers it with silence.
#[derive(Debug, Clone, Serialize)]
pub struct AgentDoc {
    /// `global` (the machine's) or `project` (this checkout's).
    pub scope: &'static str,
    /// Which CLI reads it: `claude`, `codex`, `gemini`, or `shared` for the
    /// file all of them have agreed to look at.
    pub agent: &'static str,
    /// `rules` or `skill`.
    pub kind: &'static str,
    pub name: String,
    pub path: String,
    pub exists: bool,
}

/// The Claude Code release that added `--name` and cross-session messaging.
///
/// Handing `--name` to an older CLI stops it from starting at all, so the
/// installed version is measured once per launch of the app and the flag is
/// only used where it is known to be understood.
const NAMED_SESSIONS_SINCE: (u64, u64, u64) = (2, 1, 224);

/// Ask the installed `claude` its version, bounded.
///
/// Best effort by design: a CLI that cannot answer in five seconds, or is not
/// installed at all, reads as "version unknown" — and unknown means every
/// version-gated flag stays off, the direction that never breaks a session.
async fn probe_claude_version(env: &ShellEnv) -> Option<(u64, u64, u64)> {
    let exe = env.which("claude")?;
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("--version")
        .envs(&env.vars)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let out = tokio::time::timeout(std::time::Duration::from_secs(5), cmd.output())
        .await
        .ok()?
        .ok()?;
    parse_claude_version(&String::from_utf8_lossy(&out.stdout))
}

/// `2.1.226 (Claude Code)` → `(2, 1, 226)`. Measured against the real CLI's
/// output; anything that does not lead with three dot-separated numbers is
/// "unknown", never a guess.
fn parse_claude_version(s: &str) -> Option<(u64, u64, u64)> {
    let first = s.split_whitespace().next()?;
    let mut nums = first.split('.').map(|p| p.parse::<u64>());
    match (nums.next(), nums.next(), nums.next()) {
        (Some(Ok(a)), Some(Ok(b)), Some(Ok(c))) => Some((a, b, c)),
        _ => None,
    }
}

/// A setup script waiting to wrap a launch. See `Core::launch`.
struct SetupWrap {
    script: String,
    /// The repository the worktree was opened from — where untracked files
    /// worth copying (`.env`) live. Exposed as `AGENTDESK_ROOT_PATH`.
    root_path: String,
}

/// A file path the editable diff may touch: relative, and inside the
/// worktree. The paths normally come from the diff itself, but they arrive
/// through an invoke boundary — an absolute path or a `..` step would turn
/// "edit this attempt's file" into "write anywhere on the host".
fn ensure_worktree_relative(path: &str) -> Result<()> {
    let escapes = path.is_empty()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.split(['/', '\\']).any(|c| c == "..")
        // `C:...` — a Windows drive-absolute path has no leading slash.
        || path.as_bytes().get(1) == Some(&b':');
    if escapes {
        return Err(anyhow!("`{path}` is not a path inside the worktree"));
    }
    Ok(())
}

/// A port nothing is listening on right now, for `AGENTDESK_PORT`.
///
/// Asked of the kernel rather than counted up from a base, so two attempts'
/// dev servers never fight over 3000. The listener is dropped before the
/// script starts — the standard small race, accepted everywhere.
fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// Run the repository's archive script, bounded.
///
/// Best effort by design: the worktree is being taken back either way, and a
/// script that hangs must not hold the attempt open forever — thirty seconds
/// is long enough to stop a container and short enough to still feel like
/// "closing", and what happened is logged rather than swallowed.
fn run_archive(hr: &HostRef, script: &str, worktree: &str, root: &str) {
    use std::process::{Command, Stdio};
    let mut cmd = match hr.host {
        Host::Local => {
            if !cfg!(unix) {
                eprintln!("[core] archive scripts need a POSIX shell; skipped on this platform");
                return;
            }
            let sh = hr
                .env
                .which("sh")
                .unwrap_or_else(|| std::path::PathBuf::from("/bin/sh"));
            let mut c = Command::new(sh);
            c.args(["-c", script])
                .current_dir(worktree)
                .envs(&hr.env.vars)
                .env("AGENTDESK_ROOT_PATH", root);
            c
        }
        // Inside a host the script's environment rides the argv, the same
        // way a launch's does.
        _ => {
            let envs = host::pty_env(
                hr.env,
                &[("AGENTDESK_ROOT_PATH".to_string(), root.to_string())],
            );
            let (outer, args, _) = hr.host.wrap(
                "sh",
                &["-c".to_string(), script.to_string()],
                Some(worktree),
                &envs,
            );
            let mut c = Command::new(hr.local.which(&outer).unwrap_or_else(|| outer.clone().into()));
            c.args(args);
            c
        }
    };
    let child = cmd.stdin(Stdio::null()).spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[core] archive script failed to start: {e}");
            return;
        }
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    eprintln!("[core] archive script exited with {status}");
                }
                return;
            }
            Ok(None) if std::time::Instant::now() > deadline => {
                eprintln!(
                    "[core] archive script still running after 30s; killed so the worktree can go back"
                );
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(e) => {
                eprintln!("[core] archive script: {e}");
                return;
            }
        }
    }
}


/// One row on its way to an attempt's timeline.
#[derive(Debug)]
struct PendingEvent {
    attempt_id: String,
    at: u64,
    kind: &'static str,
    tool: Option<String>,
    detail: Option<String>,
}

/// Routes PTY output onto the UI bus and keeps session status in step.
/// Which notifications the desk raises, chosen in the environment panel.
///
/// Blocked states default on — a stuck agent is the one thing this app
/// exists to surface. A finished turn defaults off: every turn ends, and a
/// default that noisy would get the whole channel disabled at the OS.
///
/// `#[serde(default)]` so a settings row written by an older build (or a
/// future one with more fields) reads as "the defaults, plus what it said".
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct NotifyPrefs {
    /// A permission decision, or the folder-trust gate.
    pub permission: bool,
    /// The idle prompt — waiting on a reply.
    pub input: bool,
    /// A turn ended. Pairs with the unread dot in the interface.
    pub done: bool,
}

impl Default for NotifyPrefs {
    fn default() -> Self {
        Self {
            permission: true,
            input: true,
            done: false,
        }
    }
}

const NOTIFY_PREFS_KEY: &str = "notify_prefs";

/// Whether a Stop hook snapshots the worktree. Default on: the cost is a
/// stat walk per turn, and the payoff is the retreat that makes letting an
/// agent run affordable. The environment panel can turn it off.
const CHECKPOINTS_KEY: &str = "checkpoints_on";

struct Router {
    sink: Arc<dyn UiSink>,
    /// The same cell the core holds, so a notification never has to upgrade
    /// the weak core reference just to know what language to speak.
    locale: Arc<crate::i18n::LocaleCell>,
    /// Shared with the core the same way the locale is: written from a
    /// command once in a while, read on every hook.
    notify_prefs: Arc<Mutex<NotifyPrefs>>,
    sessions: Arc<Mutex<HashMap<String, SessionMeta>>>,
    /// Set once the core exists, so an exiting terminal can let the queue know
    /// a slot just came free. Weak, because the core owns this router.
    core: OnceLock<std::sync::Weak<Core>>,
    /// Timeline rows leave through here rather than being written inline.
    ///
    /// `on_hook` runs on the path that must never make an agent wait: a hook
    /// that hangs is a tool call that hangs. Writing to SQLite there would put
    /// a lock shared with every broadcast in the middle of it, on every single
    /// tool call. Handing the row to a writer thread costs a channel send.
    events: std::sync::mpsc::Sender<PendingEvent>,
}

impl Router {
    fn broadcast(&self) {
        let mut list: Vec<SessionMeta> = self.sessions.lock().unwrap().values().cloned().collect();
        list.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
        let waiting = list.iter().filter(|s| s.status.needs_you()).count();
        if let Ok(v) = serde_json::to_value(&list) {
            self.sink.emit("sessions:changed", v);
        }
        self.sink
            .emit("badge", serde_json::json!({ "count": waiting }));
    }
}

impl PtySink for Router {
    fn on_output(&self, id: &str, data: String, seq: u64) {
        self.sink.emit(
            "term:output",
            serde_json::json!({ "id": id, "data": data, "seq": seq }),
        );
    }

    fn on_exit(&self, id: &str, status: String) {
        let freed = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.get_mut(id) {
                Some(s) => {
                    s.status = Status::Exited;
                    s.live = false;
                    s.attempt_id.is_some()
                }
                None => false,
            }
        };
        self.sink
            .emit("term:exit", serde_json::json!({ "id": id, "status": status }));
        self.broadcast();

        // An attempt's terminal ending is the commonest way a slot comes
        // free, so it is the main thing that makes the queue move.
        if freed {
            if let Some(core) = self.core.get().and_then(|w| w.upgrade()) {
                core.drain_queue();
                core.emit_tasks();
            }
        }
    }
}

impl HookHandler for Router {
    fn on_hook(&self, report: HookReport) {
        let HookReport {
            session_id,
            state,
            activity,
            transcript_path,
        } = report;
        let status = Status::from_hook(state);
        let at = now_ms();
        let mut timeline: Vec<PendingEvent> = Vec::new();

        let (notify, turn_done) = {
            let mut sessions = self.sessions.lock().unwrap();
            let Some(s) = sessions.get_mut(&session_id) else {
                // A hook from a session we do not track: a stale terminal from
                // a previous run of the app. Ignore it rather than inventing
                // a row for it.
                return;
            };
            s.reports_status = true;
            s.last_active_at = at;
            // Where the token account lives. First report wins — the path
            // is stable for the life of the conversation.
            if let Some(tp) = transcript_path {
                s.transcript_path.get_or_insert(tp);
            }
            let attempt_id = s.attempt_id.clone();

            // Only a tool call carries activity. A Stop or Notification report
            // has none, and must not blank out what the agent last did.
            if let Some(next) = activity {
                if s.activity.as_ref() != Some(&next) {
                    s.activity_since = at;
                }
                // Every tool call is its own moment on the timeline, including
                // a repeat of the one before it. The card shows the latest;
                // the timeline is the record.
                if let Some(id) = attempt_id.clone() {
                    timeline.push(PendingEvent {
                        attempt_id: id,
                        at,
                        kind: "tool",
                        tool: Some(next.tool.clone()),
                        detail: Some(next.detail.clone()),
                    });
                }
                s.activity = Some(next);
            }

            // Status goes on the timeline only when it actually changes, and
            // only for the states worth reading back later. `running` is
            // already implied by the tool call that carried it.
            let changed = s.status != status;
            if changed {
                if let (Some(id), true) = (attempt_id, timeline_worthy(status)) {
                    timeline.push(PendingEvent {
                        attempt_id: id,
                        at,
                        kind: "status",
                        tool: None,
                        detail: Some(status_name(status).to_string()),
                    });
                }
            }

            // Only announce a transition *into* needing a human, so a session
            // that reports the same state twice does not notify twice. A
            // turn ending (Stop → idle) is its own class, off by default —
            // and each class answers to its toggle in the environment panel.
            let entering = status.needs_you() && !s.status.needs_you();
            let turn_done = status == Status::Idle && s.status != Status::Idle;
            s.status = status;
            let prefs = *self.notify_prefs.lock().unwrap();
            let fire = if entering {
                match status {
                    Status::WaitingPermission | Status::AwaitingTrust => prefs.permission,
                    _ => prefs.input,
                }
            } else if turn_done {
                prefs.done
            } else {
                false
            };
            (fire.then(|| (s.title.clone(), s.cwd.clone())), turn_done)
        };

        for e in timeline {
            // A full or closed channel must not stall the agent. Losing a
            // timeline row is a gap in a record; blocking here is a stuck
            // tool call.
            let _ = self.events.send(e);
        }

        if let Some((title, cwd)) = notify {
            let locale = self.locale.get();
            let body = match status {
                Status::WaitingPermission => crate::i18n::waiting_permission(locale),
                Status::AwaitingTrust => crate::i18n::awaiting_trust(locale),
                Status::Idle => crate::i18n::turn_done(locale),
                _ => crate::i18n::waiting_input(locale),
            };
            self.sink.emit(
                "notify",
                serde_json::json!({
                    "title": format!("{title} {body}"),
                    "body": cwd,
                    "sessionId": session_id.clone(),
                }),
            );
        }

        self.broadcast();

        // The queued follow-up's moment: a turn just ended, and whatever
        // waited for it goes in as the next one. The same moment is the
        // checkpoint's — the worktree is quiet, so a snapshot has no tear
        // race — and the snapshot leaves the hook path immediately.
        if turn_done {
            if let Some(core) = self.core.get().and_then(|w| w.upgrade()) {
                core.flush_followup(&session_id);
                core.snapshot_after_turn(&session_id);
                core.usage_after_turn(&session_id);
            }
        }
    }
}

/// A card as the board needs it: the row, its attempts, and which session
/// each attempt is running in right now.
#[derive(Debug, Clone, Serialize)]
pub struct TaskView {
    #[serde(flatten)]
    pub task: StoredTask,
    pub attempts: Vec<AttemptView>,
    /// Where this card sits in the start queue, counting from 1, when every
    /// slot was taken at the moment 開始 was pressed.
    pub queued_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AttemptView {
    #[serde(flatten)]
    pub attempt: StoredAttempt,
    /// `None` once the attempt's session has been archived out from under it.
    pub session_id: Option<String>,
}

/// How many attempts may hold a terminal at once, before anyone says.
///
/// The product is an attention scheduler, and the thing actually being
/// rationed is a person. Three is about as many TUIs as one human can keep a
/// thread on.
const DEFAULT_MAX_CONCURRENT: i64 = 3;
const MAX_CONCURRENT_KEY: &str = "max_concurrent";

/// What pressing 開始 did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    /// Set when there was room and it started now.
    pub attempt: Option<OpenedAttempt>,
    /// Set when there was not: where it sits in the queue, counting from 1.
    pub queued_at: Option<i64>,
}

/// What opening an attempt produced.
#[derive(Debug, Clone, Serialize)]
pub struct OpenedAttempt {
    pub attempt_id: String,
    pub session_id: String,
    pub branch: String,
    pub worktree_path: String,
    /// The prompt as it was sent — or as it was built, when the agent's
    /// conventions are unknown and it is waiting to be pasted in.
    pub prompt: String,
    /// False when this CLI is one whose argument conventions have not been
    /// measured. The session is real either way; only the first message is
    /// the person's to deliver.
    pub prompt_sent: bool,
}

pub struct Core {
    pub env: ShellEnv,
    /// Language for the strings the OS renders, pushed down by the webview.
    /// Shared with the router, which raises the notifications.
    pub locale: Arc<crate::i18n::LocaleCell>,
    store: Arc<Store>,
    ptys: PtyRegistry,
    sessions: Arc<Mutex<HashMap<String, SessionMeta>>>,
    tabs: Mutex<Vec<StoredTab>>,
    sink: Arc<dyn UiSink>,
    router: Arc<Router>,
    hooks: OnceLock<HookServer>,
    data_dir: std::path::PathBuf,
    worktrees: Worktrees,
    /// The installed Claude Code's version, measured once at startup.
    /// `None` means unknown, and unknown keeps every version-gated flag off.
    claude_version: Option<(u64, u64, u64)>,
    /// Which notifications to raise — the router's copy of the same cell.
    notify_prefs: Arc<Mutex<NotifyPrefs>>,
    /// Each attempt's worktree shell, while one is live. One shell per
    /// attempt — asking again returns the session already there, so the
    /// button is idempotent and the shells never pile up. In-memory only:
    /// a shell does not outlive the app any more than the PTYs do.
    shells: Mutex<HashMap<String, String>>,
    /// One message per session, held for the end of its turn. Typing into
    /// a running claude steers the turn in flight; this is the other thing
    /// a person means — "when you are done, then this". Latest wins, and
    /// like the shells it is transient: the turn it waits on cannot
    /// outlive the app either.
    followups: Mutex<HashMap<String, String>>,
    /// Everything known about each execution environment, resolved on first
    /// use and kept: a WSL distro's login environment costs a probe, and the
    /// answer does not change under a running app.
    hosts: Mutex<HashMap<Host, Arc<HostEnv>>>,
    /// Whether the end of a turn snapshots the worktree (see
    /// `CHECKPOINTS_KEY`).
    checkpoints_on: Mutex<bool>,
    /// Attempts with a snapshot in flight. Two Stops racing — or a manual
    /// click during one — would compute the same ordinal and fight over the
    /// temp index; the second caller finds the flag and leaves.
    checkpointing: Mutex<std::collections::HashSet<String>>,
    /// Per-session progress through its transcript: the byte already
    /// consumed and the totals so far, so each turn's read costs only what
    /// the turn wrote. In-memory like the transcript path itself — the
    /// JSONL is the durable record, and a cached copy that survives a
    /// restart is a cache that lies after one.
    usage_state: Mutex<HashMap<String, UsageState>>,
}

/// What a resume did. `restore_error` set means the worktree is back on
/// its branch but the shelf checkpoint did not come down cleanly — half
/// done and visible, retryable from the timeline, never rolled back.
#[derive(Debug, Clone, Serialize)]
pub struct Resumed {
    pub session_id: String,
    pub restore_error: Option<String>,
}

/// The worlds a card can live in, enumerated — never invented. WSL comes
/// from `wsl.exe -l -q`, SSH from the aliases the person already wrote
/// into `~/.ssh/config`; an empty list is an honest "none here".
#[derive(Debug, Clone, Serialize)]
pub struct Worlds {
    pub wsl: Vec<String>,
    pub ssh: Vec<String>,
}

/// What asking a world "are you there, and do you have a claude" found.
/// `claude: None` with no error is itself an answer: reachable, but the
/// CLI is not on that world's login-shell PATH.
#[derive(Debug, Clone, Serialize)]
pub struct WorldProbe {
    pub claude: Option<String>,
    pub error: Option<String>,
}

/// Both sides of one file in an attempt's diff, as full text — the data
/// model an editable diff needs, where a patch string cannot be edited.
/// `base` is `None` for a file the attempt created; `work` is `None` for
/// one it deleted.
#[derive(Debug, Clone, Serialize)]
pub struct AttemptFile {
    pub base: Option<String>,
    pub work: Option<String>,
}

/// What a restore did: where the worktree now stands, and the automatic
/// "now" checkpoint kept first so the restore itself can be reverted.
#[derive(Debug, Clone, Serialize)]
pub struct Restored {
    /// The checkpoint the worktree now matches — `0` is the attempt's base.
    pub to_n: u64,
    pub to_sha: String,
    /// `None` when nothing had changed since the last checkpoint.
    pub saved: Option<crate::worktree::Checkpoint>,
}

/// One execution environment, resolved: its login environment, its claude,
/// and where its worktrees live. The local one mirrors the core's own fields;
/// a WSL distro's is probed through `wsl.exe` on first contact.
pub struct HostEnv {
    pub host: Host,
    pub env: ShellEnv,
    pub claude_version: Option<(u64, u64, u64)>,
    /// `~/.agentdesk/worktrees` *inside the host* — a worktree lives in the
    /// same filesystem as its repository, never across a boundary.
    pub worktree_root: String,
    /// Where this host's claude finds the status plugin: the app's own dir
    /// locally, the same dir through `/mnt` for WSL, a remotely provisioned
    /// copy (URL pointing back through the tunnel) for SSH. `None` when the
    /// hook listener is down or the tunnel could not be raised — sessions
    /// run either way, they just show no status.
    pub hook_plugin_dir: Option<String>,
}

/// What holding one session in one world takes.
///
/// Three strings rather than a command, because the command has to be built
/// twice — once to start or reattach, once to end — and both have to go
/// through the world's doorway on the way out.
struct HoldPlan {
    /// Which socket, and in which of the two shapes. Carries the desk and the
    /// session, so two installs on one machine cannot collect each other's.
    socket: pty::Socket,
    /// `-f`. Never the user's own `~/.tmux.conf`: their prefix key, their
    /// status line and their bindings belong to their terminal, not to a
    /// process this app is only babysitting.
    conf: String,
    /// Where the socket file lands, when that is on this machine.
    socket_file: Option<String>,
}

impl HostEnv {
    /// The pair of environments everything that executes needs.
    fn hr<'a>(&'a self, local: &'a ShellEnv) -> HostRef<'a> {
        HostRef {
            host: &self.host,
            local,
            env: &self.env,
        }
    }
}

impl Core {
    pub async fn start(
        sink: Arc<dyn UiSink>,
        db_path: std::path::PathBuf,
        data_dir: std::path::PathBuf,
    ) -> Result<Arc<Self>> {
        let env = shell_env::resolve().await;
        Self::start_with(env, sink, db_path, data_dir, Worktrees::default_root()).await
    }

    /// Start against a given environment and worktree root.
    ///
    /// The seam exists so the whole core can be driven without touching the
    /// person's home directory or their real agent — and so the worktree root
    /// can become a setting later without moving anything.
    pub async fn start_with(
        env: ShellEnv,
        sink: Arc<dyn UiSink>,
        db_path: std::path::PathBuf,
        data_dir: std::path::PathBuf,
        worktree_root: std::path::PathBuf,
    ) -> Result<Arc<Self>> {
        let store = Arc::new(Store::open(&db_path)?);

        let restored: HashMap<String, SessionMeta> = store
            .list_sessions()
            .unwrap_or_default()
            .into_iter()
            .map(|s| (s.id.clone(), SessionMeta::from_stored(s)))
            .collect();
        eprintln!(
            "[core] restored {} sessions from {}",
            restored.len(),
            db_path.display()
        );

        // Slots can name sessions that were archived between runs; drop them
        // so a restored tab never points at something the sidebar has no row
        // for.
        let known: std::collections::HashSet<String> = restored.keys().cloned().collect();
        let mut tabs = store.list_tabs().unwrap_or_default();
        for t in &mut tabs {
            t.slots
                .retain(|s| s.as_ref().is_some_and(|id| known.contains(id)));
        }
        if tabs.is_empty() {
            let first = StoredTab {
                id: uuid::Uuid::new_v4().to_string(),
                name: crate::i18n::default_tab_name(crate::i18n::Locale::default()).to_string(),
                layout: DEFAULT_LAYOUT.to_string(),
                slots: Vec::new(),
                position: 0,
            };
            let _ = store.upsert_tab(&first);
            tabs.push(first);
        }

        let sessions = Arc::new(Mutex::new(restored));

        // Timeline writes leave the hook path here. A plain thread rather than
        // a task: the work is a blocking SQLite insert, and the point of the
        // hand-off is to keep that off the path an agent is waiting on.
        let (events_tx, events_rx) = std::sync::mpsc::channel::<PendingEvent>();
        let writer_store = Arc::clone(&store);
        std::thread::spawn(move || {
            // Ends when the last sender drops, which is when the core goes.
            for e in events_rx {
                if let Err(err) = writer_store.append_event(
                    &e.attempt_id,
                    e.at,
                    e.kind,
                    e.tool.as_deref(),
                    e.detail.as_deref(),
                ) {
                    eprintln!("[core] timeline write failed: {err}");
                }
            }
        });

        let locale = Arc::new(crate::i18n::LocaleCell::default());

        // A malformed row reads as the defaults — same contract as the
        // profiles: a bad setting must not keep the app from starting.
        let notify_prefs = Arc::new(Mutex::new(
            store
                .setting(NOTIFY_PREFS_KEY)
                .ok()
                .flatten()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default(),
        ));

        // Same malformed-row contract as the notify prefs; absent means the
        // default, which is on.
        let checkpoints_on = store
            .setting(CHECKPOINTS_KEY)
            .ok()
            .flatten()
            .map(|raw| raw != "0")
            .unwrap_or(true);

        let claude_version = probe_claude_version(&env).await;
        if let Some((a, b, c)) = claude_version {
            eprintln!("[core] claude {a}.{b}.{c}");
        }

        let router = Arc::new(Router {
            sink: Arc::clone(&sink),
            locale: Arc::clone(&locale),
            notify_prefs: Arc::clone(&notify_prefs),
            sessions: Arc::clone(&sessions),
            core: OnceLock::new(),
            events: events_tx,
        });

        let core = Arc::new(Self {
            env,
            locale,
            store,
            ptys: PtyRegistry::new(),
            sessions,
            tabs: Mutex::new(tabs),
            sink: Arc::clone(&sink),
            router: Arc::clone(&router),
            hooks: OnceLock::new(),
            data_dir: data_dir.clone(),
            worktrees: Worktrees::new(worktree_root),
            claude_version,
            notify_prefs,
            shells: Mutex::new(HashMap::new()),
            followups: Mutex::new(HashMap::new()),
            hosts: Mutex::new(HashMap::new()),
            checkpoints_on: Mutex::new(checkpoints_on),
            checkpointing: Mutex::new(std::collections::HashSet::new()),
            usage_state: Mutex::new(HashMap::new()),
        });

        // Status reporting is a nicety: if the listener cannot bind, sessions
        // still run, they just show no status.
        match hooks::start(&data_dir, Arc::clone(&router) as Arc<dyn HookHandler>).await {
            Ok(server) => {
                let _ = core.hooks.set(server);
            }
            Err(e) => eprintln!("[core] status hooks unavailable: {e:#}"),
        }

        let _ = router.core.set(Arc::downgrade(&core));

        // Before the first paint: whatever tmux kept running is not "closed".
        core.mark_detached();

        core.broadcast();
        core.emit_tabs();
        core.emit_tasks();
        // Every terminal died with the last run, so anything that was waiting
        // for a slot has one now.
        core.drain_queue();

        // Crash leftovers: checkpoint refs whose attempt is no longer open.
        // Off the startup path — it is git work across every known repo.
        {
            let core = Arc::clone(&core);
            std::thread::spawn(move || core.sweep_checkpoint_orphans());
        }

        // The other kind of leftover, and one this desk created by asking
        // tmux to hold things: a held session whose card is gone.
        {
            let core = Arc::clone(&core);
            std::thread::spawn(move || core.sweep_held_orphans());
        }
        Ok(core)
    }

    /* ---------------------------- hosts ---------------------------- */

    /// The resolved environment for one host, probed on first contact.
    ///
    /// Resolution happens outside the map lock: a WSL probe takes a moment,
    /// and nothing else should queue behind it. Two first contacts racing
    /// probe twice and the second insert wins — wasteful once, wrong never.
    fn host_env(&self, h: &Host) -> Result<Arc<HostEnv>> {
        if let Some(he) = self.hosts.lock().unwrap().get(h) {
            return Ok(Arc::clone(he));
        }
        let he = Arc::new(match h {
            Host::Local => HostEnv {
                host: Host::Local,
                env: self.env.clone(),
                claude_version: self.claude_version,
                worktree_root: self.worktrees.local_root(),
                hook_plugin_dir: self
                    .hooks
                    .get()
                    .map(|s| s.plugin_dir.to_string_lossy().to_string()),
            },
            _ => {
                let env = h.probe_env(&self.env)?;
                let home = env.vars.get("HOME").cloned().ok_or_else(|| {
                    anyhow!("the host's environment came back without a HOME")
                })?;
                // The host's claude, not ours — its version gates its flags.
                let hr = HostRef {
                    host: h,
                    local: &self.env,
                    env: &env,
                };
                let claude_version = hr
                    .run_ok("claude", &["--version"], None)
                    .ok()
                    .and_then(|s| parse_claude_version(&s));
                let hook_plugin_dir = match h {
                    Host::Local => unreachable!(),
                    // The plugin sits on the app's disk; a claude inside WSL
                    // reads it through the drive mounts.
                    Host::Wsl { .. } => self
                        .hooks
                        .get()
                        .map(|s| host::win_path_for_wsl(&s.plugin_dir.to_string_lossy())),
                    // An SSH host cannot see our disk at all: the plugin is
                    // provisioned into the host, and its URL points back
                    // through the reverse tunnel on the standing connection.
                    Host::Ssh { host } => self.hooks.get().and_then(|server| {
                        let remote_port =
                            20000 + (uuid::Uuid::new_v4().as_u128() % 40000) as u16;
                        if !host::open_ssh_master(&self.env, host, remote_port, server.port) {
                            return None;
                        }
                        let url =
                            format!("http://127.0.0.1:{remote_port}/h/{}", server.token);
                        let dir = format!("{home}/.agentdesk/plugin");
                        for (rel, contents) in hooks::plugin_files(&url) {
                            if let Err(e) = hr.write_file(&format!("{dir}/{rel}"), &contents) {
                                eprintln!("[core] provisioning hooks on `{host}` failed: {e:#}");
                                return None;
                            }
                        }
                        Some(dir)
                    }),
                };
                HostEnv {
                    host: h.clone(),
                    env,
                    claude_version,
                    worktree_root: format!("{home}/.agentdesk/worktrees"),
                    hook_plugin_dir,
                }
            }
        });
        self.hosts
            .lock()
            .unwrap()
            .insert(h.clone(), Arc::clone(&he));
        Ok(he)
    }

    /// Split a stored path and resolve its host in one motion — the shape
    /// nearly every caller wants.
    fn located(&self, raw: &str) -> Result<(host::Located, Arc<HostEnv>)> {
        let loc = host::locate(raw)?;
        let he = self.host_env(&loc.host)?;
        Ok((loc, he))
    }

    /* ---------------------------- tasks ---------------------------- */

    /// Make a card.
    ///
    /// The repository is checked here rather than when someone first tries to
    /// run the card, so a card that can never produce an attempt cannot be
    /// created in the first place. Ad-hoc sessions are subject to none of
    /// this — they are just a directory.
    pub fn create_task(
        &self,
        title: String,
        prompt: String,
        repo_path: String,
        base_branch: String,
    ) -> Result<String> {
        let (loc, he) = self.located(&repo_path)?;
        self.worktrees
            .check_repo(&he.hr(&self.env), &loc.path, &base_branch)?;

        let id = uuid::Uuid::new_v4().to_string();
        let position = self
            .store
            .list_tasks()
            .unwrap_or_default()
            .iter()
            .filter(|t| t.lifecycle == Lifecycle::Backlog)
            .count() as i64;

        self.store.upsert_task(&StoredTask {
            id: id.clone(),
            title,
            prompt,
            repo_path,
            base_branch,
            lifecycle: Lifecycle::Backlog,
            position,
            created_at: now_ms(),
        })?;
        self.emit_tasks();
        Ok(id)
    }

    /// Move a card, or reorder it within its column.
    ///
    /// Only ever called from a drag. Nothing the agent reports reaches this:
    /// a `Stop` hook means "this turn ended", not "the work is finished", and
    /// the distance between those two is the entire reason the board and the
    /// session lights are separate axes.
    pub fn move_task(&self, id: &str, lifecycle: Lifecycle, position: i64) -> Result<()> {
        let mut tasks = self.store.list_tasks()?;
        let Some(idx) = tasks.iter().position(|t| t.id == id) else {
            return Err(anyhow!("no such task: {id}"));
        };

        let mut moved = tasks.remove(idx);
        let was = moved.lifecycle;
        moved.lifecycle = lifecycle;

        // Renumber both affected columns from scratch. Positions are only
        // meaningful relative to their neighbours, and rewriting them is far
        // cheaper than reasoning about which of them shifted.
        let mut column: Vec<StoredTask> =
            tasks.iter().filter(|t| t.lifecycle == lifecycle).cloned().collect();
        let at = (position.max(0) as usize).min(column.len());
        column.insert(at, moved);

        for (i, t) in column.iter_mut().enumerate() {
            t.position = i as i64;
            self.store.upsert_task(t)?;
        }
        if was != lifecycle {
            for (i, t) in tasks
                .iter_mut()
                .filter(|t| t.lifecycle == was)
                .enumerate()
            {
                t.position = i as i64;
                self.store.upsert_task(t)?;
            }
        }
        self.emit_tasks();
        Ok(())
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        // Attempts still holding a worktree have to give it back first, or
        // the directories outlive every record that they exist.
        for attempt in self.store.list_attempts(id)? {
            if attempt.outcome.is_none() {
                let _ = self.close_attempt(&attempt, Outcome::Discarded);
            }
        }
        self.store.delete_task(id)?;
        self.emit_tasks();
        Ok(())
    }

    /// Every card, with its attempts and their live sessions.
    pub fn task_board(&self) -> Vec<TaskView> {
        let by_attempt: HashMap<String, String> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter_map(|s| s.attempt_id.clone().map(|a| (a, s.id.clone())))
            .collect();

        let queue: HashMap<String, i64> = self
            .store
            .queue()
            .unwrap_or_default()
            .into_iter()
            .enumerate()
            .map(|(i, q)| (q.task_id, i as i64 + 1))
            .collect();

        self.store
            .list_tasks()
            .unwrap_or_default()
            .into_iter()
            .map(|task| {
                let attempts = self
                    .store
                    .list_attempts(&task.id)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|attempt| AttemptView {
                        session_id: by_attempt.get(&attempt.id).cloned(),
                        attempt,
                    })
                    .collect();
                let queued_at = queue.get(&task.id).copied();
                TaskView {
                    task,
                    attempts,
                    queued_at,
                }
            })
            .collect()
    }

    /* --------------------------- attempts -------------------------- */

    /// The first message, as it would be sent, for the dialog to show and let
    /// the person edit before anything is spawned.
    ///
    /// The branch and base here are the best guess available before the
    /// worktree exists. `open_attempt` renders again against what git
    /// actually handed back, so an edited prompt is used verbatim and an
    /// unedited one is never left quoting a number it did not get.
    pub fn preview_prompt(&self, task_id: &str, agent: &str) -> Result<serde_json::Value> {
        let task = self.task(task_id)?;
        let text = self.render_prompt(&task, None)?;
        // A profile resolves before the question is asked: what matters is
        // the CLI underneath, not what the person calls it.
        let (agent, _) = self.resolve_launcher(agent);
        Ok(serde_json::json!({
            "prompt": text,
            // So the dialog can say plainly that this one will not be sent
            // for you, rather than letting you press a button that quietly
            // does nothing.
            "willSend": prompt::delivery_for(&agent) == Delivery::Positional,
        }))
    }

    /// Open a worktree for this card and start an agent in it.
    ///
    /// `first_prompt` is what the dialog showed, after any edits. It is sent
    /// as written and recorded on the timeline as written, so what the agent
    /// was actually asked is never inferred after the fact.
    /// Start an attempt, or put it in the queue if every slot is taken.
    ///
    /// Queueing rather than refusing, because the answer to "too many at
    /// once" is "later", not "no". The prompt is stored exactly as approved:
    /// when its turn comes it sends what the person saw, not a re-render of a
    /// template that may have been edited since.
    pub fn start_attempt(
        &self,
        task_id: &str,
        agent: String,
        first_prompt: Option<String>,
        mode: PermissionMode,
        cols: u16,
        rows: u16,
    ) -> Result<StartResult> {
        let task = self.task(task_id)?;
        if self.running_attempts() >= self.max_concurrent() {
            let prompt = match first_prompt {
                Some(p) => p,
                None => self.render_prompt(&task, None)?,
            };
            let position = self.store.next_queue_position()?;
            self.store.enqueue_start(&crate::store::QueuedStart {
                id: uuid::Uuid::new_v4().to_string(),
                task_id: task_id.to_string(),
                agent,
                prompt,
                mode,
                cols,
                rows,
                position,
                created_at: now_ms(),
            })?;
            let at = self
                .store
                .queue()?
                .iter()
                .position(|q| q.task_id == task_id)
                .map(|i| i as i64 + 1)
                .unwrap_or(1);
            self.emit_tasks();
            return Ok(StartResult {
                attempt: None,
                queued_at: Some(at),
            });
        }

        let opened = self.open_attempt(task_id, agent, first_prompt, mode, cols, rows)?;
        Ok(StartResult {
            attempt: Some(opened),
            queued_at: None,
        })
    }

    /// How many attempts hold a terminal right now. This is the thing the
    /// quota rations — a saved attempt costs nobody any attention.
    pub fn running_attempts(&self) -> i64 {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.live && s.attempt_id.is_some())
            .count() as i64
    }

    pub fn max_concurrent(&self) -> i64 {
        self.store
            .setting(MAX_CONCURRENT_KEY)
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok())
            .filter(|n| *n >= 1)
            .unwrap_or(DEFAULT_MAX_CONCURRENT)
    }

    /// Raising the limit lets waiting cards go at once; that is the point of
    /// raising it.
    pub fn set_max_concurrent(&self, n: i64) -> Result<()> {
        self.store
            .set_setting(MAX_CONCURRENT_KEY, &n.max(1).to_string())?;
        self.drain_queue();
        self.emit_tasks();
        Ok(())
    }

    pub fn cancel_queued(&self, task_id: &str) -> Result<()> {
        self.store.dequeue(task_id)?;
        self.emit_tasks();
        Ok(())
    }

    /// Start whatever the freed slots can take.
    ///
    /// Called whenever a slot might have opened. A queued start that fails —
    /// its repository moved, its base branch went — is dropped from the queue
    /// with a note rather than retried forever in front of the ones behind it.
    pub fn drain_queue(&self) {
        loop {
            if self.running_attempts() >= self.max_concurrent() {
                return;
            }
            let Some(next) = self.store.queue().ok().and_then(|q| q.into_iter().next()) else {
                return;
            };
            // Off the queue first, so a failure cannot loop on it.
            let _ = self.store.dequeue(&next.task_id);
            match self.open_attempt(
                &next.task_id,
                next.agent.clone(),
                Some(next.prompt.clone()),
                next.mode,
                next.cols,
                next.rows,
            ) {
                Ok(opened) => {
                    eprintln!(
                        "[core] queue: started {} on {}",
                        next.task_id, opened.branch
                    );
                }
                Err(e) => {
                    eprintln!("[core] queue: {} could not start: {e:#}", next.task_id);
                    self.sink.emit(
                        "notify",
                        serde_json::json!({
                            "title": crate::i18n::queued_start_failed(self.locale.get()),
                            "body": format!("{e:#}"),
                            "sessionId": serde_json::Value::Null,
                        }),
                    );
                }
            }
        }
    }

    pub fn queue(&self) -> Vec<crate::store::QueuedStart> {
        self.store.queue().unwrap_or_default()
    }

    fn open_attempt(
        &self,
        task_id: &str,
        agent: String,
        first_prompt: Option<String>,
        mode: PermissionMode,
        cols: u16,
        rows: u16,
    ) -> Result<OpenedAttempt> {
        let task = self.task(task_id)?;
        let (loc, he) = self.located(&task.repo_path)?;
        let seq = self.store.next_attempt_seq(task_id)?;
        let slug = worktree::slug(&task.title, &task.id);

        let wt = self.worktrees.create(
            &he.hr(&self.env),
            &he.worktree_root,
            &loc.path,
            &task.base_branch,
            &slug,
            seq,
        )?;

        // From here on a failure has a worktree to give back.
        let opened = self.finish_opening(&task, agent, first_prompt, mode, &loc, &he, &wt, cols, rows);
        if opened.is_err() {
            let _ = self
                .worktrees
                .remove(&he.hr(&self.env), &loc.path, &wt.path);
        }
        let opened = opened?;

        self.move_task(task_id, Lifecycle::Running, 0)?;
        self.emit_tasks();
        self.broadcast();
        Ok(opened)
    }

    #[allow(clippy::too_many_arguments)]
    fn finish_opening(
        &self,
        task: &StoredTask,
        agent: String,
        first_prompt: Option<String>,
        mode: PermissionMode,
        loc: &host::Located,
        he: &HostEnv,
        wt: &worktree::OpenedWorktree,
        cols: u16,
        rows: u16,
    ) -> Result<OpenedAttempt> {
        // The picked launcher becomes an actual CLI here — a queued start
        // carries the profile's *name* and resolves only now, so it runs
        // whatever the profile says at the moment it actually starts.
        let (agent, profile_args) = self.resolve_launcher(&agent);
        let attempt_id = uuid::Uuid::new_v4().to_string();
        // Stored in the app's path space, so every later reader knows which
        // host to ask; inside the host it is `wt.path` plain.
        let cwd = host::stored(&he.host, &wt.path);

        let text = match first_prompt {
            Some(edited) => edited,
            None => self.render_prompt(task, Some(wt))?,
        };

        // The repository's own word on how a worktree becomes runnable. A
        // malformed file fails the start here, in the dialog, rather than
        // producing a worktree that is mysteriously not set up.
        let config_path = he.host.join(&loc.path, config::FILE);
        let setup = he
            .hr(&self.env)
            .read_to_string(&config_path)?
            .map(|text| config::parse(&text, &config_path))
            .transpose()?
            .unwrap_or_default()
            .setup
            .map(|script| SetupWrap {
                script,
                // The path scripts see is the host's own: `$AGENTDESK_ROOT_PATH`
                // is for `cp`, and `cp` runs inside.
                root_path: loc.path.clone(),
            });

        let delivery = prompt::delivery_for(&agent);
        let positional = match delivery {
            Delivery::Positional => Some(text.clone()),
            Delivery::Manual => None,
        };

        let session_id = uuid::Uuid::new_v4().to_string();
        let at = now_ms();
        // A brand-new worktree always opens on the folder-trust prompt, and
        // no hook can report that. See `Status::AwaitingTrust`.
        //
        // With a setup script in front, the trust prompt arrives whenever the
        // script finishes — which the core cannot see. `Starting` is the
        // honest label for "watch the terminal", and the setup's own output
        // is right there explaining what the wait is.
        let status = if setup.is_some() {
            Status::Starting
        } else if delivery == Delivery::Positional {
            Status::AwaitingTrust
        } else {
            Status::Starting
        };

        let meta = SessionMeta {
            id: session_id.clone(),
            cwd: cwd.clone(),
            title: format!("{} #{}", task.title, wt.seq),
            agent: agent.clone(),
            status,
            created_at: at,
            last_active_at: at,
            live: true,
            reports_status: false,
            activity: None,
            activity_since: 0,
            completed: false,
            attempt_id: Some(attempt_id.clone()),
            has_followup: false,
            preview_port: None,
            usage: None,
            transcript_path: None,
        };

        // Visible before it can speak. The PTY reports its exit against the
        // sessions map, and a setup script that fails in milliseconds beats
        // the rest of this function to that report — so the session goes on
        // the record first and launches second, or an instant death would
        // land on a map that had never heard of it and the session would sit
        // at "starting" forever.
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), meta.clone());

        // The profile's standing arguments first, then the mode's flags —
        // all options, ahead of `--plugin-dir` and the prompt. The mode's
        // flags are measured for Claude Code only; any other CLI launches
        // without them rather than being handed a guess. The mode is still
        // recorded either way — it is what the person approved.
        let mut opts = profile_args;
        if agent == "claude" {
            opts.extend(mode.claude_args().iter().map(|s| s.to_string()));
        }

        // `--continue` is deliberately absent: this worktree has no history
        // for it to continue, and the prompt is what starts the work.
        if let Err(e) = self.launch(
            &session_id,
            &agent,
            opts,
            positional,
            &cwd,
            cols,
            rows,
            setup.as_ref(),
        ) {
            self.sessions.lock().unwrap().remove(&session_id);
            return Err(e);
        }

        self.store.insert_attempt(&StoredAttempt {
            id: attempt_id.clone(),
            task_id: task.id.clone(),
            seq: wt.seq,
            agent,
            worktree_path: cwd.clone(),
            branch: wt.branch.clone(),
            base_sha: wt.base_sha.clone(),
            mode,
            outcome: None,
            frozen_diff: None,
            created_at: at,
            parked_at: None,
        })?;

        self.persist(&meta);

        // Recorded as sent, not as templated: the dialog is editable, and the
        // timeline has to show what the agent was actually asked.
        let _ = self
            .store
            .append_event(&attempt_id, at, "prompt", None, Some(&text));

        Ok(OpenedAttempt {
            attempt_id,
            session_id,
            branch: wt.branch.clone(),
            worktree_path: cwd,
            prompt: text,
            prompt_sent: delivery == Delivery::Positional,
        })
    }

    /// Put a terminal back on an attempt that is not running.
    ///
    /// After a restart this is the state every attempt is in — the app kills
    /// its PTYs on the way out and the agent's own history on disk is what
    /// survives. `--continue` reads that history; the prompt is deliberately
    /// not sent again, because a second copy would set the agent off doing the
    /// whole card from the beginning.
    pub fn reopen_attempt(&self, attempt_id: &str, cols: u16, rows: u16) -> Result<String> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            return Err(anyhow!(
                "attempt {attempt_id} is finished; its worktree has been removed"
            ));
        }
        if attempt.parked_at.is_some() {
            return Err(anyhow!(
                "attempt {attempt_id} is parked — resume it, which grows the worktree back first"
            ));
        }
        let (wt_loc, he) = self.located(&attempt.worktree_path)?;
        if !he.hr(&self.env).is_dir(&wt_loc.path) {
            return Err(anyhow!(
                "the worktree at {} is gone",
                attempt.worktree_path
            ));
        }

        let existing = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .find(|s| s.attempt_id.as_deref() == Some(attempt_id))
            .map(|s| s.id.clone());

        if let Some(id) = existing {
            if self.ptys.is_live(&id) {
                return Err(anyhow!("attempt {attempt_id} already has a terminal"));
            }
            self.reopen_session(&id, cols, rows)?;
            return Ok(id);
        }

        // The session row was archived out from under the attempt. Give it a
        // new terminal on the same worktree; the agent's history is in the
        // directory, not in our row.
        let session_id = uuid::Uuid::new_v4().to_string();
        let at = now_ms();
        let opts = if attempt.agent == "claude" {
            // The permission mode rides along on a resume: it is part of what
            // was approved for this attempt, not a per-launch choice.
            let mut o = vec!["--continue".to_string()];
            o.extend(attempt.mode.claude_args().iter().map(|s| s.to_string()));
            o
        } else {
            Vec::new()
        };
        let meta = SessionMeta {
            id: session_id.clone(),
            cwd: attempt.worktree_path.clone(),
            title: format!("attempt #{}", attempt.seq),
            agent: attempt.agent.clone(),
            status: Status::Starting,
            created_at: at,
            last_active_at: at,
            live: true,
            reports_status: false,
            activity: None,
            activity_since: 0,
            completed: false,
            attempt_id: Some(attempt_id.to_string()),
            has_followup: false,
            preview_port: None,
            usage: None,
            transcript_path: None,
        };
        // On the record before it can exit — see `finish_opening`.
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), meta.clone());
        if let Err(e) = self.launch(
            &session_id,
            &attempt.agent,
            opts,
            None,
            &attempt.worktree_path,
            cols,
            rows,
            // Setup ran when the worktree was made; reopening continues.
            None,
        ) {
            self.sessions.lock().unwrap().remove(&session_id);
            return Err(e);
        }
        self.persist(&meta);
        self.broadcast();
        Ok(session_id)
    }

    /// End an attempt: freeze what it did, then give the worktree back.
    ///
    /// The order matters. Removing the worktree first would take the diff
    /// with it, and an attempt whose evidence is gone cannot be reviewed —
    /// which is the whole reason a superseded attempt is kept at all.
    pub fn finish_attempt(&self, attempt_id: &str, outcome: Outcome) -> Result<()> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        self.close_attempt(&attempt, outcome)?;
        self.emit_tasks();
        self.broadcast();
        self.drain_queue();
        Ok(())
    }

    fn close_attempt(&self, attempt: &StoredAttempt, outcome: Outcome) -> Result<()> {
        let task = self.task(&attempt.task_id).ok();
        let worktree = attempt.worktree_path.clone();
        let situated = self.located(&worktree).ok();

        // Best effort: a worktree that has already been deleted by hand must
        // not stop the attempt from being closed out. A parked attempt has
        // no worktree by design — its frozen diff is base against the shelf
        // checkpoint, read straight from the object store.
        let diff = if attempt.parked_at.is_some() {
            task.as_ref().and_then(|t| {
                let (repo_loc, he) = self.located(&t.repo_path).ok()?;
                let hr = he.hr(&self.env);
                let cps = self.worktrees.checkpoints(&hr, &repo_loc.path, &attempt.id).ok()?;
                let last = cps.last()?;
                self.worktrees
                    .diff_range(&hr, &repo_loc.path, &attempt.base_sha, &last.sha)
                    .ok()
            })
        } else {
            situated.as_ref().and_then(|(loc, he)| {
                self.worktrees
                    .diff(&he.hr(&self.env), &loc.path, &attempt.base_sha)
                    .ok()
            })
        };

        self.store
            .finish_attempt(&attempt.id, outcome, diff.as_deref())?;

        // The session goes with the directory it was running in — and so does
        // anything else living there. A dev server started from the Run
        // button is an ad-hoc session whose cwd is this worktree, and a
        // terminal whose directory has been deleted is a trap that looks
        // alive.
        let doomed: Vec<String> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| {
                // Compared in the stored path space, where both sides carry
                // their host prefix — a WSL dev server matches its WSL
                // worktree and nothing else's.
                s.attempt_id.as_deref() == Some(&attempt.id)
                    || s.cwd == worktree
                    || s.cwd
                        .starts_with(&format!("{}/", worktree.trim_end_matches('/')))
            })
            .map(|s| s.id.clone())
            .collect();
        for id in doomed {
            self.ptys.kill(&id);
            let _ = self.store.archive_session(&id);
            self.sessions.lock().unwrap().remove(&id);
        }

        if let (Some(task), Some((wt_loc, he))) = (task, situated) {
            let repo_loc = host::locate(&task.repo_path)?;
            let hr = he.hr(&self.env);
            // The frozen diff is the record from here on; the snapshots go
            // with the attempt. Best effort, and against the main checkout —
            // the refs live in the shared git dir, not the worktree.
            if let Err(e) = self
                .worktrees
                .clear_checkpoints(&hr, &repo_loc.path, &attempt.id)
            {
                eprintln!("[core] checkpoint refs for {} not cleared: {e:#}", attempt.id);
            }
            // The archive script gets its chance while the directory still
            // exists — the place to stop containers or give back whatever
            // setup borrowed.
            if hr.is_dir(&wt_loc.path) {
                let config_path = he.host.join(&repo_loc.path, config::FILE);
                match hr
                    .read_to_string(&config_path)
                    .and_then(|t| t.map(|t| config::parse(&t, &config_path)).transpose())
                {
                    Ok(Some(cfg)) => {
                        if let Some(script) = cfg.archive {
                            run_archive(&hr, &script, &wt_loc.path, &repo_loc.path);
                        }
                    }
                    Ok(None) => {}
                    // Closing must not be stopped by a config typo; the
                    // person is taking the worktree back either way.
                    Err(e) => eprintln!("[core] archive script skipped: {e:#}"),
                }
            }
            self.worktrees.remove(&hr, &repo_loc.path, &wt_loc.path)?;
        }
        Ok(())
    }

    pub fn attempt_events(&self, attempt_id: &str) -> Result<Vec<crate::store::AttemptEvent>> {
        self.store.list_events(attempt_id)
    }

    /* --------------------------- profiles --------------------------- */

    /// Everything a launch dialog can offer: the bare agents, then the
    /// person's profiles. The dialogs render this instead of carrying their
    /// own list, so a new profile — or one day a new agent — is data, not a
    /// frontend change.
    pub fn launchers(&self) -> Result<Vec<Launcher>> {
        let mut list: Vec<Launcher> = BARE_AGENTS
            .iter()
            .map(|a| Launcher {
                name: a.to_string(),
                agent: a.to_string(),
                profile: false,
            })
            .collect();
        for p in self.store.profiles()? {
            list.push(Launcher {
                name: p.name,
                agent: p.agent,
                profile: true,
            });
        }
        Ok(list)
    }

    pub fn profiles(&self) -> Result<Vec<Profile>> {
        self.store.profiles()
    }

    /// Replace the profiles, after checking they can actually be offered:
    /// every name says something, no two say the same thing, and none of
    /// them says "claude" while meaning something else.
    pub fn set_profiles(&self, profiles: Vec<Profile>) -> Result<()> {
        let mut seen = std::collections::HashSet::new();
        for p in &profiles {
            let name = p.name.trim();
            if name.is_empty() {
                return Err(anyhow!("a profile needs a name"));
            }
            if p.agent.trim().is_empty() {
                return Err(anyhow!("profile `{name}` names no agent CLI"));
            }
            if BARE_AGENTS.contains(&name) {
                return Err(anyhow!(
                    "`{name}` is an agent's own name; a profile may not shadow it"
                ));
            }
            if !seen.insert(name.to_string()) {
                return Err(anyhow!("two profiles are both called `{name}`"));
            }
        }
        self.store.set_profiles(&profiles)
    }

    /// What a picked launcher name means: a profile's agent and standing
    /// arguments, or — for any other string — a bare binary with none. The
    /// fallback is today's semantics kept honest: `agent` has always been a
    /// binary resolved on the login-shell PATH, so a profile deleted while a
    /// card sat in the queue degrades to a name the spawn will report as not
    /// found, rather than to a silent guess.
    fn resolve_launcher(&self, name: &str) -> (String, Vec<String>) {
        if let Ok(profiles) = self.store.profiles() {
            if let Some(p) = profiles.into_iter().find(|p| p.name == name) {
                return (p.agent, p.args);
            }
        }
        (name.to_string(), Vec::new())
    }

    /// The names of the repository's run scripts, for the drawer's buttons.
    pub fn list_run_scripts(&self, attempt_id: &str) -> Result<Vec<String>> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        let task = self.task(&attempt.task_id)?;
        let (loc, he) = self.located(&task.repo_path)?;
        let config_path = he.host.join(&loc.path, config::FILE);
        Ok(he
            .hr(&self.env)
            .read_to_string(&config_path)?
            .map(|t| config::parse(&t, &config_path))
            .transpose()?
            .unwrap_or_default()
            .run
            .into_iter()
            .map(|r| r.name)
            .collect())
    }

    /// Start one of the repository's run scripts in the attempt's worktree.
    ///
    /// The script gets a terminal of its own — a dev server's output is a
    /// thing to watch, and watching is what this app does. The session is
    /// ad-hoc on purpose: it has no lifecycle and takes no slot, because the
    /// quota rations agents (attention), and a dev server asks for none.
    /// `AGENTDESK_PORT` carries a port nothing else is on, so two attempts'
    /// servers never fight over 3000.
    pub fn run_script(
        &self,
        attempt_id: &str,
        name: &str,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            return Err(anyhow!("attempt {attempt_id} is finished; its worktree has been removed"));
        }
        let task = self.task(&attempt.task_id)?;
        let (repo_loc, he) = self.located(&task.repo_path)?;
        let wt_loc = host::locate(&attempt.worktree_path)?;
        // A local host needs a local POSIX shell; a WSL host brings its own.
        if matches!(he.host, Host::Local) && !cfg!(unix) {
            return Err(anyhow!("run scripts need a POSIX shell"));
        }
        let config_path = he.host.join(&repo_loc.path, config::FILE);
        let config = he
            .hr(&self.env)
            .read_to_string(&config_path)?
            .map(|t| config::parse(&t, &config_path))
            .transpose()?
            .ok_or_else(|| anyhow!("{} has no {}", task.repo_path, config::FILE))?;
        let script = config
            .run
            .into_iter()
            .find(|r| r.name == name)
            .ok_or_else(|| anyhow!("no run script named `{name}` in {}", config::FILE))?;

        let port = match &he.host {
            Host::Local => free_port()?,
            // The kernel that owns the port is the host's; asked from here
            // the answer would describe the wrong machine. A high port drawn
            // from randomness collides rarely, and a colliding dev server
            // fails loudly in its own terminal.
            _ => 20000 + (uuid::Uuid::new_v4().as_u128() % 40000) as u16,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let at = now_ms();
        let meta = SessionMeta {
            id: id.clone(),
            cwd: attempt.worktree_path.clone(),
            title: format!("▶ {name}"),
            agent: "sh".to_string(),
            status: Status::Starting,
            created_at: at,
            last_active_at: at,
            live: true,
            reports_status: false,
            activity: None,
            activity_since: 0,
            completed: false,
            // Ad-hoc: no lifecycle, no slot. The attempt link would also put
            // it on the card, and the card is about the agent.
            attempt_id: None,
            has_followup: false,
            // Reachable worlds only: local directly, WSL through mirrored
            // networking. An SSH host's port lives on the remote, and a
            // recorded port nobody can dial would put a preview button on
            // a door that opens onto a wall.
            preview_port: match &he.host {
                Host::Ssh { .. } => None,
                _ => Some(port),
            },
            usage: None,
            transcript_path: None,
        };

        let script_env = [
            ("AGENTDESK_PORT".to_string(), port.to_string()),
            ("AGENTDESK_ROOT_PATH".to_string(), repo_loc.path.clone()),
        ];
        let (program, args, outer_cwd, outer_env): (String, Vec<String>, Option<String>, Vec<(String, String)>) =
            match &he.host {
                Host::Local => (
                    "sh".to_string(),
                    vec!["-c".to_string(), script.command],
                    Some(wt_loc.path.clone()),
                    script_env.to_vec(),
                ),
                _ => {
                    let envs = host::pty_env(&he.env, &script_env);
                    let (p, a, _) = he.host.wrap(
                        "sh",
                        &["-c".to_string(), script.command],
                        Some(&wt_loc.path),
                        &envs,
                    );
                    (p, a, None, Vec::new())
                }
            };

        // On the record before it can exit — see `finish_opening`. A script
        // that dies at once (`command not found`) must die visibly.
        self.sessions.lock().unwrap().insert(id.clone(), meta.clone());
        if let Err(e) = self.ptys.spawn(
            &id,
            &program,
            &args,
            outer_cwd.as_deref(),
            &self.env,
            &outer_env,
            cols.max(20),
            rows.max(5),
            Arc::clone(&self.router) as Arc<dyn PtySink>,
            // Not held: a script and a shell are things you started to
            // watch, and they end when the desk does.
            None,
        ) {
            self.sessions.lock().unwrap().remove(&id);
            return Err(e);
        }

        self.persist(&meta);
        self.broadcast();
        Ok(id)
    }

    /// A shell of the person's own, in the attempt's worktree.
    ///
    /// Reviewing an agent's work keeps demanding ad-hoc commands — run the
    /// tests, `git log`, grep — in *its* worktree, not yours. The ▶ scripts
    /// cover what the repository predicted; this covers everything it did
    /// not, without typing into the agent's terminal and without hunting
    /// the worktree path to `cd` into. The shell is the host's own login
    /// shell, so inside WSL it is the distro's, with the distro's PATH.
    pub fn open_shell(&self, attempt_id: &str, cols: u16, rows: u16) -> Result<String> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            return Err(anyhow!(
                "attempt {attempt_id} is finished; its worktree has been removed"
            ));
        }

        // One shell per attempt: while it lives, the button returns it
        // rather than stacking a second.
        if let Some(existing) = self.shells.lock().unwrap().get(attempt_id) {
            if self
                .sessions
                .lock()
                .unwrap()
                .get(existing)
                .is_some_and(|s| s.live)
            {
                return Ok(existing.clone());
            }
        }

        let task = self.task(&attempt.task_id)?;
        let (repo_loc, he) = self.located(&task.repo_path)?;
        let wt_loc = host::locate(&attempt.worktree_path)?;
        if matches!(he.host, Host::Local) && !cfg!(unix) {
            return Err(anyhow!("a worktree shell needs a POSIX shell"));
        }

        let id = uuid::Uuid::new_v4().to_string();
        let at = now_ms();
        let shell = he.env.shell.clone();
        let meta = SessionMeta {
            id: id.clone(),
            cwd: attempt.worktree_path.clone(),
            title: format!("$ {} #{}", task.title, attempt.seq),
            agent: shell
                .rsplit(['/', '\\'])
                .find(|s| !s.is_empty())
                .unwrap_or("sh")
                .to_string(),
            status: Status::Starting,
            created_at: at,
            last_active_at: at,
            live: true,
            reports_status: false,
            activity: None,
            activity_since: 0,
            completed: false,
            // Ad-hoc, like the ▶ scripts: no lifecycle, no slot — the card
            // is about the agent, and this terminal is about you.
            attempt_id: None,
            has_followup: false,
            preview_port: None,
            usage: None,
            transcript_path: None,
        };

        // The same variable the scripts see, because the same need exists:
        // the repository the worktree was opened from is where untracked
        // things worth reaching (.env) live.
        let shell_env = [(
            "AGENTDESK_ROOT_PATH".to_string(),
            repo_loc.path.clone(),
        )];
        let (program, args, outer_cwd, outer_env): (
            String,
            Vec<String>,
            Option<String>,
            Vec<(String, String)>,
        ) = match &he.host {
            Host::Local => (
                shell,
                Vec::new(),
                Some(wt_loc.path.clone()),
                shell_env.to_vec(),
            ),
            _ => {
                let envs = host::pty_env(&he.env, &shell_env);
                let (p, a, _) = he.host.wrap(&shell, &[], Some(&wt_loc.path), &envs);
                (p, a, None, Vec::new())
            }
        };

        self.sessions.lock().unwrap().insert(id.clone(), meta.clone());
        if let Err(e) = self.ptys.spawn(
            &id,
            &program,
            &args,
            outer_cwd.as_deref(),
            &self.env,
            &outer_env,
            cols.max(20),
            rows.max(5),
            Arc::clone(&self.router) as Arc<dyn PtySink>,
            // Not held: a script and a shell are things you started to
            // watch, and they end when the desk does.
            None,
        ) {
            self.sessions.lock().unwrap().remove(&id);
            return Err(e);
        }

        self.shells
            .lock()
            .unwrap()
            .insert(attempt_id.to_string(), id.clone());
        self.persist(&meta);
        self.broadcast();
        Ok(id)
    }

    /// The attempt's footprint at a glance — numstat counts and where its
    /// branch stands against the base, for the card badges. A finished
    /// attempt has no worktree left and no standing to measure; its frozen
    /// diff already says everything it will ever say.
    pub fn attempt_stats(&self, attempt_id: &str) -> Result<worktree::DiffStat> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            return Err(anyhow!("attempt is finished"));
        }
        let task = self.task(&attempt.task_id)?;
        let (wt_loc, he) = self.located(&attempt.worktree_path)?;
        self.worktrees.stat(
            &he.hr(&self.env),
            &wt_loc.path,
            &attempt.base_sha,
            &task.base_branch,
        )
    }

    /// The attempt's diff: live from the worktree while it still exists, and
    /// the frozen copy once it does not.
    /// What the agent working here already knows before anyone types.
    ///
    /// Slots, not discoveries: a rules file that is missing is still listed,
    /// with its path and marked absent, because the useful answer to "where
    /// do the conventions go" is the path itself. Skills are the exception —
    /// a skill is whatever somebody wrote — so those are read off disk.
    ///
    /// Every supported CLI's convention appears, not only the one this
    /// session happens to run. Hooks, checkpoints and the token account are
    /// all Claude-only by measurement; this is the rare surface where the
    /// other agents get exactly what Claude gets, and narrowing it to the
    /// running agent would throw that away for nothing.
    pub fn agent_docs(&self, cwd: &str) -> Result<Vec<AgentDoc>> {
        let (loc, he) = self.located(cwd)?;
        let hr = he.hr(&self.env);
        let home = he
            .env
            .vars
            .get("HOME")
            .or_else(|| he.env.vars.get("USERPROFILE"))
            .cloned();
        let mut out = Vec::new();

        for (name, agent) in [
            ("CLAUDE.md", "claude"),
            ("AGENTS.md", "shared"),
            ("GEMINI.md", "gemini"),
        ] {
            let path = hr.join(&loc.path, name);
            out.push(AgentDoc {
                scope: "project",
                agent,
                kind: "rules",
                exists: hr.exists(&path),
                name: name.to_string(),
                path,
            });
        }

        if let Some(home) = home.as_deref() {
            for (dir, name, agent) in [
                (".claude", "CLAUDE.md", "claude"),
                (".codex", "AGENTS.md", "codex"),
                (".gemini", "GEMINI.md", "gemini"),
            ] {
                let path = hr.join(&hr.join(home, dir), name);
                out.push(AgentDoc {
                    scope: "global",
                    agent,
                    kind: "rules",
                    exists: hr.exists(&path),
                    name: name.to_string(),
                    path,
                });
            }
        }

        // One directory per skill, each holding a SKILL.md. A directory
        // without one is somebody's notes, not a skill, and stays out.
        let roots = [
            ("project", hr.join(&hr.join(&loc.path, ".claude"), "skills")),
            (
                "global",
                home.as_deref()
                    .map(|h| hr.join(&hr.join(h, ".claude"), "skills"))
                    .unwrap_or_default(),
            ),
        ];
        for (scope, root) in roots {
            if root.is_empty() {
                continue;
            }
            for entry in hr.list_dir(&root) {
                let path = hr.join(&hr.join(&root, &entry), "SKILL.md");
                if hr.exists(&path) {
                    out.push(AgentDoc {
                        scope,
                        agent: "claude",
                        kind: "skill",
                        exists: true,
                        name: entry,
                        path,
                    });
                }
            }
        }
        Ok(out)
    }

    pub fn attempt_diff(&self, attempt_id: &str) -> Result<String> {
        self.attempt_diff_from(attempt_id, None)
    }

    /// The same diff with the baseline swapped: against checkpoint `against`
    /// instead of the attempt's base, answering "what has happened since
    /// that snapshot" with the rendering the drawer already has. `0` (or
    /// `None`) is the base itself.
    pub fn attempt_diff_from(&self, attempt_id: &str, against: Option<u64>) -> Result<String> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if let Some(frozen) = attempt.frozen_diff {
            return match against {
                None | Some(0) => Ok(frozen),
                Some(n) => Err(anyhow!(
                    "a finished attempt has no checkpoint #{n} left to compare against — \
                     its refs are gone and the frozen diff is the record"
                )),
            };
        }
        // Parked: no worktree to diff against, but the shelf checkpoint is
        // the worktree as it was parked — so the diff runs tree against
        // tree in the main checkout, ending at the shelf.
        if attempt.parked_at.is_some() {
            let task = self.task(&attempt.task_id)?;
            let (repo_loc, he) = self.located(&task.repo_path)?;
            let hr = he.hr(&self.env);
            let cps = self.worktrees.checkpoints(&hr, &repo_loc.path, attempt_id)?;
            let Some(last) = cps.last() else {
                // Parked clean at base: nothing ever changed.
                return Ok(String::new());
            };
            let from = match against {
                None | Some(0) => attempt.base_sha.clone(),
                Some(n) => cps
                    .iter()
                    .find(|c| c.n == n)
                    .map(|c| c.sha.clone())
                    .ok_or_else(|| anyhow!("this attempt has no checkpoint #{n}"))?,
            };
            if from == last.sha {
                return Ok(String::new());
            }
            return self.worktrees.diff_range(&hr, &repo_loc.path, &from, &last.sha);
        }
        let (wt_loc, he) = self.located(&attempt.worktree_path)?;
        let hr = he.hr(&self.env);
        let base = match against {
            None | Some(0) => attempt.base_sha.clone(),
            Some(n) => self
                .worktrees
                .checkpoints(&hr, &wt_loc.path, attempt_id)?
                .into_iter()
                .find(|c| c.n == n)
                .map(|c| c.sha)
                .ok_or_else(|| anyhow!("this attempt has no checkpoint #{n}"))?,
        };
        self.worktrees.diff(&hr, &wt_loc.path, &base)
    }

    /* ---------------------------- worlds --------------------------- */

    /// Enumerate the worlds a card could live in. Cheap by construction:
    /// one `wsl.exe -l -q` (milliseconds, and an instant failure anywhere
    /// wsl.exe does not exist) and one local file read — never a remote
    /// probe, so a dead SSH host cannot slow the menu down.
    pub fn list_worlds(&self) -> Worlds {
        let wsl = std::process::Command::new("wsl.exe")
            .args(["-l", "-q"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| host::parse_wsl_list(&o.stdout))
            .unwrap_or_default();
        let ssh = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .ok()
            .map(|home| std::path::Path::new(&home).join(".ssh").join("config"))
            .and_then(|p| std::fs::read_to_string(p).ok())
            .map(|text| host::parse_ssh_config(&text))
            .unwrap_or_default();
        Worlds { wsl, ssh }
    }

    /// Ask one world whether it is reachable and what claude it carries.
    /// `world` is the stored-path prefix ('' for local, `wsl://Ubuntu`,
    /// `ssh://devbox`). Runs the full login-shell probe on first contact
    /// and answers from the `hosts` cache afterwards — the same cache a
    /// card's first attempt would warm anyway.
    pub fn probe_world(&self, world: &str) -> WorldProbe {
        let raw = if world.is_empty() {
            "/".to_string()
        } else {
            format!("{world}/")
        };
        match self.located(&raw) {
            Ok((_, he)) => WorldProbe {
                claude: he.claude_version.map(|(a, b, c)| format!("{a}.{b}.{c}")),
                error: None,
            },
            Err(e) => WorldProbe {
                claude: None,
                error: Some(format!("{e:#}")),
            },
        }
    }

    /// Both sides of one file in the diff, as full text — what the editable
    /// diff edits. The base side comes from the attempt's recorded base
    /// commit, the work side from the worktree as it stands. A finished or
    /// parked attempt has no ground to read: its diff is a record.
    pub fn attempt_file(&self, attempt_id: &str, path: &str) -> Result<AttemptFile> {
        ensure_worktree_relative(path)?;
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            return Err(anyhow!(
                "this attempt is finished — its frozen diff is a record, not a document"
            ));
        }
        if attempt.parked_at.is_some() {
            return Err(anyhow!("this attempt is parked — there is no worktree to read"));
        }
        let (wt_loc, he) = self.located(&attempt.worktree_path)?;
        let hr = he.hr(&self.env);
        let base = self
            .worktrees
            .file_at_rev(&hr, &wt_loc.path, &attempt.base_sha, path)?;
        let work = hr.read_to_string(&hr.join(&wt_loc.path, path))?;
        Ok(AttemptFile { base, work })
    }

    /// Write one file in the attempt's worktree — a human's own edit, made
    /// where the eye already is. This is not the app touching agent state:
    /// a person can change any file in their repository with any editor,
    /// and this only removes the navigation. Restore's two rules carry
    /// over whole: settled only — re-verified here, because UI gating goes
    /// stale — and the "tell the agent" note stays a human act, upstairs.
    ///
    /// `expected` is the text the editor believes the disk holds — what it
    /// loaded, or last saved. When it is given and the disk disagrees, the
    /// save is refused: a shell, a run script, or a turn that started and
    /// settled while the editor sat open has written here, and last-write-
    /// wins would destroy that work without anyone seeing it go.
    pub fn write_attempt_file(
        &self,
        attempt_id: &str,
        path: &str,
        contents: &str,
        expected: Option<&str>,
    ) -> Result<()> {
        ensure_worktree_relative(path)?;
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            return Err(anyhow!(
                "this attempt is finished — its frozen diff is a record, not a document"
            ));
        }
        if attempt.parked_at.is_some() {
            return Err(anyhow!(
                "this attempt is parked — resume it first, then edit"
            ));
        }
        let busy = self.sessions.lock().unwrap().values().any(|s| {
            s.attempt_id.as_deref() == Some(attempt_id)
                && s.live
                && !matches!(s.status, Status::Idle | Status::Saved | Status::Exited)
        });
        if busy {
            return Err(anyhow!(
                "the agent is mid-turn in this worktree. Saving now would change files under \
                 its feet while it is still writing its own. Wait for the turn to end — or \
                 close the session — and save then"
            ));
        }
        let (wt_loc, he) = self.located(&attempt.worktree_path)?;
        let hr = he.hr(&self.env);
        let full = hr.join(&wt_loc.path, path);
        if let Some(expected) = expected {
            let current = hr.read_to_string(&full)?.unwrap_or_default();
            if current != expected {
                return Err(anyhow!(
                    "{path} changed on disk after the editor read it — a shell, a script, or \
                     another turn wrote here. Close the editor and reopen it to see the current \
                     text; saving now would overwrite that work unseen"
                ));
            }
        }
        hr.write_file(&full, contents)?;
        Ok(())
    }

    /// The first message for this card.
    ///
    /// With a worktree in hand it names the branch and base that were really
    /// handed out. Without one — previewing, or queueing before anything has
    /// been created — it names the best guess available, and `open_attempt`
    /// renders again against what git actually gave it.
    fn render_prompt(
        &self,
        task: &StoredTask,
        wt: Option<&worktree::OpenedWorktree>,
    ) -> Result<String> {
        let template = prompt::load_or_create(&self.data_dir)?;
        let (branch, base_sha) = match wt {
            Some(w) => (w.branch.clone(), w.base_sha.clone()),
            None => {
                let seq = self.store.next_attempt_seq(&task.id)?;
                let slug = worktree::slug(&task.title, &task.id);
                let sha = self
                    .located(&task.repo_path)
                    .and_then(|(loc, he)| {
                        self.worktrees
                            .head_of(&he.hr(&self.env), &loc.path, &task.base_branch)
                    })
                    .unwrap_or_default();
                (format!("agentdesk/{slug}-{seq}"), sha)
            }
        };
        Ok(prompt::render(
            &template,
            &prompt::Vars {
                title: &task.title,
                branch: &branch,
                base_branch: &task.base_branch,
                base_sha: &base_sha,
                prompt: &task.prompt,
            },
        ))
    }

    /* ---------------------------- finishing ------------------------ */

    /// Fold an attempt's branch back into its base, then close the attempt
    /// out. The merge has to succeed before anything is given up.
    pub fn merge_attempt(&self, attempt_id: &str) -> Result<String> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        let task = self.task(&attempt.task_id)?;

        let (repo_loc, he) = self.located(&task.repo_path)?;
        let wt_loc = host::locate(&attempt.worktree_path)?;
        let sha = self.worktrees.merge_to_base(
            &he.hr(&self.env),
            &repo_loc.path,
            &wt_loc.path,
            &attempt.branch,
            &task.base_branch,
        )?;

        self.close_attempt(&attempt, Outcome::Merged)?;

        // The merge is the moment the card's question is answered. Any other
        // attempt still open on it was a candidate for the same work, and the
        // candidate that did not land is superseded — not discarded, because
        // nobody threw it away; it lost. Its diff freezes like any close, so
        // comparing what the losing agent did remains possible afterwards.
        for other in self.store.list_attempts(&attempt.task_id)? {
            if other.id != attempt.id && other.outcome.is_none() {
                if let Err(e) = self.close_attempt(&other, Outcome::Superseded) {
                    // The merge itself succeeded; a sibling whose worktree
                    // would not come back is a mess to report, not to undo.
                    eprintln!("[core] superseding attempt {} failed: {e:#}", other.id);
                }
            }
        }

        self.emit_tasks();
        self.broadcast();
        self.drain_queue();
        Ok(sha)
    }

    /// Send a later message into an attempt's live terminal.
    ///
    /// This is how the review drawer answers "what is still wrong" without a
    /// navigation: the composed feedback goes in through the PTY the same way
    /// a person's paste would, and lands on the timeline as what was actually
    /// asked. Only for CLIs whose conventions are measured — for the rest the
    /// text is the person's to paste, exactly like the first prompt.
    pub fn send_followup(&self, session_id: &str, text: &str) -> Result<()> {
        if text.trim().is_empty() {
            return Err(anyhow!("nothing to send"));
        }
        let (agent, attempt_id) = {
            let sessions = self.sessions.lock().unwrap();
            let s = sessions
                .get(session_id)
                .ok_or_else(|| anyhow!("no such session: {session_id}"))?;
            (s.agent.clone(), s.attempt_id.clone())
        };
        if prompt::delivery_for(&agent) != Delivery::Positional {
            return Err(anyhow!(
                "`{agent}`'s input conventions have not been measured; copy the text in instead"
            ));
        }

        self.write(session_id, &prompt::bracketed_followup(text))?;

        // Recorded as sent, like the first prompt: the timeline is the record
        // of what the agent was asked, follow-ups included.
        if let Some(id) = attempt_id {
            let _ = self.store.append_event(&id, now_ms(), "prompt", None, Some(text));
        }
        Ok(())
    }

    /// The repository's branches, recency first, for the base picker.
    pub fn list_branches(&self, repo_path: &str) -> Result<Vec<String>> {
        let (loc, he) = self.located(repo_path)?;
        self.worktrees.branches(&he.hr(&self.env), &loc.path)
    }

    /// Hold a message for the end of this turn.
    ///
    /// The same gates as sending now — a live terminal, measured input
    /// conventions — checked at queue time, because a refusal the moment
    /// you press the button beats one after the turn you waited out.
    pub fn queue_followup(&self, session_id: &str, text: &str) -> Result<()> {
        if text.trim().is_empty() {
            return Err(anyhow!("nothing to queue"));
        }
        {
            let sessions = self.sessions.lock().unwrap();
            let s = sessions
                .get(session_id)
                .ok_or_else(|| anyhow!("no such session: {session_id}"))?;
            if !s.live {
                return Err(anyhow!("no terminal for session {session_id}"));
            }
            if prompt::delivery_for(&s.agent) != Delivery::Positional {
                return Err(anyhow!(
                    "`{}`'s input conventions have not been measured; copy the text in instead",
                    s.agent
                ));
            }
        }
        self.followups
            .lock()
            .unwrap()
            .insert(session_id.to_string(), text.to_string());
        self.set_followup_flag(session_id, true);
        Ok(())
    }

    pub fn cancel_followup(&self, session_id: &str) {
        self.followups.lock().unwrap().remove(session_id);
        self.set_followup_flag(session_id, false);
    }

    /// The Stop hook's half: the turn just ended, so what waited for it
    /// goes in as the next one — through the same paste a live follow-up
    /// uses, recorded on the timeline the same way.
    pub(crate) fn flush_followup(&self, session_id: &str) {
        let Some(text) = self.followups.lock().unwrap().remove(session_id) else {
            return;
        };
        if let Err(e) = self.send_followup(session_id, &text) {
            // The session died between queue and Stop. The message is
            // dropped rather than retried into a terminal that is gone.
            eprintln!("[core] queued follow-up for {session_id} failed: {e:#}");
        }
        self.set_followup_flag(session_id, false);
    }

    fn set_followup_flag(&self, session_id: &str, value: bool) {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(session_id) {
            s.has_followup = value;
        }
        self.broadcast();
    }

    /// Push the branch and open a pull request.
    ///
    /// The attempt is deliberately *not* closed out: the worktree stays until
    /// the pull request is resolved, because that is when there is still
    /// something to change in response to review. Reviewing and merging a
    /// pull request is somebody else's tool.
    pub fn open_pr(&self, attempt_id: &str) -> Result<String> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        let task = self.task(&attempt.task_id)?;

        let body = format!(
            "AgentDesk attempt #{} ({}), from `{}` @ {}.\n\n---\n\n{}",
            attempt.seq,
            attempt.agent,
            task.base_branch,
            &attempt.base_sha[..attempt.base_sha.len().min(8)],
            task.prompt
        );
        let (wt_loc, he) = self.located(&attempt.worktree_path)?;
        self.worktrees.push_and_open_pr(
            &he.hr(&self.env),
            &wt_loc.path,
            &attempt.branch,
            &task.base_branch,
            &task.title,
            &body,
        )
    }

    fn task(&self, id: &str) -> Result<StoredTask> {
        self.store
            .list_tasks()?
            .into_iter()
            .find(|t| t.id == id)
            .ok_or_else(|| anyhow!("no such task: {id}"))
    }

    fn emit_tasks(&self) {
        if let Ok(v) = serde_json::to_value(self.task_board()) {
            self.sink.emit("tasks:changed", v);
        }
    }

    /* --------------------------- commands -------------------------- */

    /// Open a new terminal session running `agent` in `cwd`.
    ///
    /// `extra_args` is passed through verbatim — `--continue`, `--model
    /// sonnet`, anything the CLI accepts, exactly as the user would type it.
    pub fn new_session(
        &self,
        cwd: String,
        agent: String,
        extra_args: Vec<String>,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        // A profile name resolves to its CLI and standing arguments; the
        // person's own arguments come after, so they can override. The row
        // remembers the resolved CLI — reopening runs `claude`, whatever the
        // profile was called.
        let (agent, mut opts) = self.resolve_launcher(&agent);
        opts.extend(extra_args);
        let extra_args = opts;
        let id = uuid::Uuid::new_v4().to_string();
        let title = std::path::Path::new(&cwd)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| cwd.clone());
        let at = now_ms();

        let meta = SessionMeta {
            id: id.clone(),
            cwd: cwd.clone(),
            title,
            agent: agent.clone(),
            status: Status::Starting,
            created_at: at,
            last_active_at: at,
            live: true,
            reports_status: false,
            activity: None,
            activity_since: 0,
            completed: false,
            attempt_id: None,
            has_followup: false,
            preview_port: None,
            usage: None,
            transcript_path: None,
        };

        // On the record before it can exit — see `finish_opening`.
        self.sessions.lock().unwrap().insert(id.clone(), meta.clone());
        if let Err(e) = self.launch(&id, &agent, extra_args, None, &cwd, cols, rows, None) {
            self.sessions.lock().unwrap().remove(&id);
            return Err(e);
        }

        self.persist(&meta);
        self.broadcast();
        Ok(id)
    }

    /// Reattach a terminal to a saved session, continuing the agent's own
    /// conversation history in that directory.
    pub fn reopen_session(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let meta = self
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no such session: {id}"))?;

        if self.ptys.is_live(id) {
            return Err(anyhow!("session {id} already has a terminal"));
        }

        // `--continue` picks up the most recent conversation in this
        // directory, which is what reopening means to the user.
        let mut args = if meta.agent == "claude" {
            vec!["--continue".to_string()]
        } else {
            Vec::new()
        };
        // An attempt session resumes with the permission mode chosen for the
        // attempt — approved once, kept until the attempt ends.
        if meta.agent == "claude" {
            if let Some(attempt_id) = &meta.attempt_id {
                if let Ok(Some(attempt)) = self.store.get_attempt(attempt_id) {
                    args.extend(attempt.mode.claude_args().iter().map(|s| s.to_string()));
                }
            }
        }

        // Marked live before the launch, not after: a child that exits at
        // once reports Exited in between, and writing "starting, live" over
        // that report would leave a zombie row nothing can ever update.
        //
        // **Attaching is not starting.** A session tmux held through a
        // restart is already running, and `new-session -A -D` reattaches to
        // it and drops the argv on the floor — so no `SessionStart` fires,
        // and nothing would ever move the row off 啟動中. It would sit there
        // for the rest of the session's life, which is the same lie the
        // status label used to tell, told from the other side.
        //
        // So the honest state is kept: running, and this desk has not heard
        // from it yet. The first real hook replaces it, which is now a thing
        // that can happen again (see `hooks::start`).
        let attaching = self
            .sessions
            .lock()
            .unwrap()
            .get(id)
            .map(|s| s.status == Status::Detached)
            .unwrap_or(false);
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.status = if attaching {
                Status::Detached
            } else {
                Status::Starting
            };
            s.live = true;
            s.last_active_at = now_ms();
        }
        if let Err(e) = self.launch(id, &meta.agent, args, None, &meta.cwd, cols, rows, None) {
            if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
                s.status = Status::Saved;
                s.live = false;
            }
            return Err(e);
        }
        self.broadcast();
        Ok(())
    }

    /// Spawn the PTY, adding the status plugin and its identifying env.
    ///
    /// `opts` and `positional` are kept apart so the command line can be
    /// assembled in the only order that is safe: every option, then the
    /// prompt. Appending `--plugin-dir` to a vector that already ended with
    /// the prompt would put a positional argument in front of an option and
    /// leave the parse to the CLI's goodwill.
    ///
    /// With a `setup` wrap, the launch becomes `sh -c 'set -e; <setup>;
    /// exec "$0" "$@"' <agent> <args…>` — the script runs first, in the same
    /// terminal, and then *becomes* the agent. The arguments ride as real
    /// argv entries, untouched by the shell, so the multi-line prompt needs
    /// no quoting and arrives exactly as it would have without the wrap.
    #[allow(clippy::too_many_arguments)]
    fn launch(
        &self,
        id: &str,
        agent: &str,
        opts: Vec<String>,
        positional: Option<String>,
        cwd: &str,
        cols: u16,
        rows: u16,
        setup: Option<&SetupWrap>,
    ) -> Result<()> {
        // Which world this session's directory lives in decides everything
        // below: whose claude, whose PATH, and whether the whole command
        // line gets wrapped through the doorway.
        let loc = host::locate(cwd)?;
        let he = self.host_env(&loc.host)?;

        let mut session_env = Vec::new();
        // Which plugin dir — and whether there is one — was settled when the
        // host was first contacted; see `host_env`. Only the session's
        // identity is per-launch.
        let plugin_dir = he.hook_plugin_dir.clone();
        if plugin_dir.is_some() {
            session_env.push(("AGENTDESK_SESSION_ID".to_string(), id.to_string()));
        }

        // Cross-session messaging addresses a session by name, and left to
        // itself the CLI derives one from the worktree's directory — a slug
        // with a counter. AgentDesk knows the card, so a claude session is
        // named what its own list calls it: 「修好登入 #1」, reachable by the
        // name a person would actually say. Version-gated on the claude that
        // will actually run — the host's — because an older CLI refuses to
        // start on a flag it does not know.
        let mut opts = opts;
        if agent == "claude" && he.claude_version >= Some(NAMED_SESSIONS_SINCE) {
            if let Some(title) = self.sessions.lock().unwrap().get(id).map(|s| s.title.clone()) {
                opts.push("--name".to_string());
                opts.push(title);
            }
        }

        let args = build_args(agent, opts, plugin_dir.as_deref(), positional);

        // A local host needs a local POSIX shell for the setup wrap; a WSL
        // host brings its own.
        let posix = cfg!(unix) || !matches!(he.host, Host::Local);
        let (program, args) = match setup {
            Some(wrap) if posix => {
                session_env.push(("AGENTDESK_ROOT_PATH".to_string(), wrap.root_path.clone()));
                // `set -e` so a failed setup stops in front of the person,
                // in the terminal, instead of starting an agent in a
                // half-made workspace.
                let script = format!("set -e\n{}\nexec \"$0\" \"$@\"", wrap.script);
                let mut wrapped = vec!["-c".to_string(), script, agent.to_string()];
                wrapped.extend(args);
                ("sh".to_string(), wrapped)
            }
            Some(_) => {
                eprintln!(
                    "[core] setup scripts need a POSIX shell; launching {agent} directly"
                );
                (agent.to_string(), args)
            }
            None => (agent.to_string(), args),
        };

        // Only the agent's own session is held. A run script and a worktree
        // shell are things you started to watch; an agent is a thing you
        // started to leave running, and that difference is the whole reason
        // to involve tmux at all.
        //
        // Composed here, *before* the doorway, so the tmux that holds the
        // process is the one belonging to the world the process runs in. Put
        // it after the wrap and it could only ever be this machine's — which
        // is useless for a WSL world, since a WSL world only exists on a
        // Windows host and there is no native Windows tmux to be the holder.
        let plan = self.hold_plan(&he.host, id);
        let (program, args) = match &plan {
            Some(p) => pty::hold_attach(&p.socket, &p.conf, Some(&loc.path), &program, &args),
            None => (program, args),
        };

        // Locally the PTY applies cwd and env natively; inside a host both
        // ride the wrapped argv, and the outer process is the doorway.
        let (program, args, outer_cwd, outer_env): (String, Vec<String>, Option<String>, Vec<(String, String)>) =
            match &he.host {
                Host::Local => (program, args, Some(loc.path.clone()), session_env),
                _ => {
                    let envs = host::pty_env(&he.env, &session_env);
                    let (p, a, _) = he.host.wrap(&program, &args, Some(&loc.path), &envs);
                    (p, a, None, Vec::new())
                }
            };

        // Ending it travels the same road. A socket in another world is
        // unlinked by the command that kills its server, since this process
        // cannot reach that filesystem to do it afterwards.
        let hold = plan.map(|p| {
            let (dp, da) = pty::hold_destroy(&p.socket);
            let (dp, da) = match &he.host {
                Host::Local => (dp, da),
                _ => {
                    let (x, y, _) = he.host.wrap(&dp, &da, None, &[]);
                    (x, y)
                }
            };
            pty::Hold {
                destroy: (dp, da),
                socket_file: p.socket_file,
            }
        });

        self.ptys.spawn(
            id,
            &program,
            &args,
            outer_cwd.as_deref(),
            &self.env,
            &outer_env,
            cols.max(20),
            rows.max(5),
            Arc::clone(&self.router) as Arc<dyn PtySink>,
            hold.as_ref(),
        )
    }

    /// Forward keystrokes to the terminal, verbatim.
    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.last_active_at = now_ms();
        }
        self.ptys.write(id, data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.ptys.resize(id, cols.max(20), rows.max(5))
    }

    /// Everything the terminal has emitted so far, for a pane that is only
    /// now mounting. See `PtyRegistry::snapshot`.
    pub fn snapshot(&self, id: &str) -> Result<(String, u64)> {
        self.ptys.snapshot(id)
    }

    pub fn close_session(&self, id: &str) -> Result<()> {
        self.ptys.kill(id);
        let freed = {
            let mut sessions = self.sessions.lock().unwrap();
            match sessions.get_mut(id) {
                Some(s) => {
                    s.status = Status::Saved;
                    s.live = false;
                    s.attempt_id.is_some()
                }
                None => false,
            }
        };
        self.broadcast();
        if freed {
            self.drain_queue();
            self.emit_tasks();
        }
        Ok(())
    }

    /// Drop the session from the list. Its scrollback is gone either way —
    /// the agent's own conversation history on disk is untouched.
    pub fn archive_session(&self, id: &str) -> Result<()> {
        self.ptys.kill(id);
        self.store.archive_session(id)?;
        self.sessions.lock().unwrap().remove(id);
        self.broadcast();
        Ok(())
    }

    /// Mark a session done, or undo that. Nothing infers this: `Stop` means
    /// "this turn ended", never "the work is finished".
    pub fn set_completed(&self, id: &str, completed: bool) -> Result<()> {
        let meta = {
            let mut sessions = self.sessions.lock().unwrap();
            let s = sessions
                .get_mut(id)
                .ok_or_else(|| anyhow!("no such session: {id}"))?;
            s.completed = completed;
            if completed {
                s.activity = None;
            }
            s.clone()
        };
        self.persist(&meta);
        self.broadcast();
        Ok(())
    }

    /* ---------------------------- tabs ----------------------------- */

    pub fn tabs(&self) -> Vec<StoredTab> {
        self.tabs.lock().unwrap().clone()
    }

    pub fn create_tab(&self, name: String) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let tab = {
            let mut tabs = self.tabs.lock().unwrap();
            let tab = StoredTab {
                id: id.clone(),
                name,
                layout: DEFAULT_LAYOUT.to_string(),
                slots: Vec::new(),
                position: tabs.len() as i64,
            };
            tabs.push(tab.clone());
            tab
        };
        self.store.upsert_tab(&tab)?;
        self.emit_tabs();
        Ok(id)
    }

    pub fn rename_tab(&self, id: &str, name: String) -> Result<()> {
        let tab = {
            let mut tabs = self.tabs.lock().unwrap();
            let t = tabs
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or_else(|| anyhow!("no such tab: {id}"))?;
            t.name = name;
            t.clone()
        };
        self.store.upsert_tab(&tab)?;
        self.emit_tabs();
        Ok(())
    }

    /// Remove a tab. The sessions it showed are untouched — they keep running
    /// and stay in the sidebar, because a tab is a view, not a container.
    pub fn close_tab(&self, id: &str) -> Result<()> {
        {
            let mut tabs = self.tabs.lock().unwrap();
            if tabs.len() <= 1 {
                return Err(anyhow!("the last tab cannot be closed"));
            }
            tabs.retain(|t| t.id != id);
            for (i, t) in tabs.iter_mut().enumerate() {
                t.position = i as i64;
            }
        }
        self.store.delete_tab(id)?;
        for t in self.tabs.lock().unwrap().iter() {
            let _ = self.store.upsert_tab(t);
        }
        self.emit_tabs();
        Ok(())
    }

    /// Set a tab's arrangement.
    ///
    /// A session appears in at most one tab. It owns a single PTY and
    /// therefore a single size, so being shown in two arrangements at once
    /// would mean resizing it against itself every time you switched. Claiming
    /// a session here removes it from wherever it was — it *leaves* the other
    /// tab's list rather than blanking a position in it, because a position
    /// nobody occupies is indistinguishable from one the user deliberately
    /// emptied, and the frontend used to have to guess between the two.
    pub fn update_tab(&self, id: &str, layout: String, slots: Vec<Option<String>>) -> Result<()> {
        let claimed: std::collections::HashSet<&str> =
            slots.iter().filter_map(|s| s.as_deref()).collect();

        let changed = {
            let mut tabs = self.tabs.lock().unwrap();
            if !tabs.iter().any(|t| t.id == id) {
                return Err(anyhow!("no such tab: {id}"));
            }
            for t in tabs.iter_mut() {
                if t.id == id {
                    t.layout = layout.clone();
                    t.slots = slots.clone();
                } else {
                    t.slots
                        .retain(|s| !s.as_deref().is_some_and(|x| claimed.contains(x)));
                }
            }
            tabs.clone()
        };

        for t in &changed {
            self.store.upsert_tab(t)?;
        }
        self.emit_tabs();
        Ok(())
    }

    fn emit_tabs(&self) {
        if let Ok(v) = serde_json::to_value(self.tabs()) {
            self.sink.emit("tabs:changed", v);
        }
    }

    pub fn shutdown(&self) {
        self.ptys.kill_all();
        // Give the hook port back. It is part of the address every held
        // session was told to report to, so the next run has to be able to
        // take it again — and a listener nobody stops keeps it for as long as
        // this process lives.
        if let Some(h) = self.hooks.get() {
            h.stop();
        }
        // Close the standing SSH connections, tunnels and all — with
        // ControlPersist they would otherwise outlive the app.
        for h in self.hosts.lock().unwrap().keys() {
            if let Host::Ssh { host } = h {
                host::close_ssh_master(&self.env, host);
            }
        }
    }

    pub fn sessions(&self) -> Vec<SessionMeta> {
        let mut v: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        v.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
        v
    }

    pub fn hook_url(&self) -> Option<String> {
        self.hooks.get().map(|h| h.url())
    }

    /// Ask tmux which of the sessions we just loaded are still running.
    ///
    /// `from_stored` marks everything `Saved`, which was true when every
    /// terminal died with the app. It is not true any more, and a card that
    /// says "closed" over a working agent is worse than a missing feature —
    /// somebody reads it, believes the work is gone, and starts a second
    /// attempt onto the same worktree.
    ///
    /// Runs before the first paint rather than on a thread: a status that
    /// corrects itself a moment later is a flicker on the one surface whose
    /// whole job is being trusted at a glance. `has-session` is a socket
    /// connect, so the cost is a millisecond apiece.
    ///
    /// Sessions in worlds that hold nothing simply have no socket to find,
    /// so they stay `Saved` without needing to be asked about separately.
    fn mark_detached(&self) {
        // The resolved path, not the bare name. The guard used to ask the
        // login-shell PATH and the call then asked the *process* PATH, which
        // is the Finder stub `shell_env` exists to work around: on a Mac
        // whose tmux came from Homebrew, `which` finds it, the spawn fails
        // ENOENT, and every held session comes back Saved — the exact lie
        // this state was added to stop.
        let Some(tmux) = self.env.which("tmux") else { return };
        let tag = self.desk_tag();
        let mut sessions = self.sessions.lock().unwrap();
        for (id, meta) in sessions.iter_mut() {
            if meta.status != Status::Saved {
                continue;
            }
            let sock = pty::Socket::Named(pty::hold_socket(&tag, id));
            if tmux_answers(&tmux, &sock) {
                meta.status = Status::Detached;
            }
        }
    }

    /// Whether this world can hold a session past the app's own life, and
    /// what it takes to.
    ///
    /// Persistence is a property of a **world**, not a premise of the app —
    /// the same ruling `worlds.md` already made about which machine a card
    /// runs on. A world with tmux gets it; a world without keeps the old
    /// behaviour exactly.
    ///
    /// Local only so far. What changed is where the tmux line is built: it
    /// used to be built inside `PtyRegistry::spawn`, which could only ever
    /// build a local one, and is now built here and handed through the same
    /// doorway as everything else. That is the whole of what another world
    /// needs from this side.
    fn hold_plan(&self, host: &Host, session_id: &str) -> Option<HoldPlan> {
        if !matches!(host, Host::Local) || self.env.which("tmux").is_none() {
            return None;
        }
        let conf = self.data_dir.join("tmux.conf");
        // Rewritten each start rather than once: an upgrade that changes what
        // tmux is told must not wait for someone to delete a stale file.
        if std::fs::write(&conf, pty::HOLD_CONF).is_err() {
            return None;
        }
        let name = pty::hold_socket(&self.desk_tag(), session_id);
        let socket_file = tmux_socket_dir().map(|d| d.join(&name).to_string_lossy().to_string());
        Some(HoldPlan {
            socket: pty::Socket::Named(name),
            conf: conf.to_string_lossy().to_string(),
            socket_file,
        })
    }

    /// This desk's tag, from where it keeps its data — so two installs on
    /// one machine never collect each other's held sessions.
    fn desk_tag(&self) -> String {
        pty::desk_tag(&self.data_dir.to_string_lossy())
    }

    /// Kill held sessions this desk no longer has a card for.
    ///
    /// Asking tmux to outlive the app is a promise to come back for what was
    /// left running. A session removed from the list, or a crash between the
    /// spawn and the write, leaves an agent nobody will look at again and
    /// nothing else can name — so the sweep is not tidiness, it is the other
    /// half of the feature.
    ///
    /// Sockets are read off disk because that is the only place an id this
    /// desk has forgotten still exists. Scoped by the desk tag, so a sweep
    /// can only ever reach this install's own leftovers.
    fn sweep_held_orphans(&self) {
        let Some(tmux) = self.env.which("tmux") else { return };
        let Some(dir) = tmux_socket_dir() else { return };
        let prefix = format!("agentdesk-{}-", self.desk_tag());
        let known: std::collections::HashSet<String> = self
            .sessions
            .lock()
            .unwrap()
            .keys()
            .map(|id| pty::hold_socket(&self.desk_tag(), id))
            .collect();
        let Ok(entries) = std::fs::read_dir(&dir) else { return };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.starts_with(&prefix) || known.contains(&name) {
                continue;
            }
            let sock = pty::Socket::Named(name.clone());
            if tmux_answers(&tmux, &sock) {
                let (_, args) = pty::hold_destroy(&sock);
                let _ = std::process::Command::new(&tmux).args(&args).output();
            }
            // tmux leaves the socket inode behind when a server exits, so a
            // dead socket looks exactly like a live one from here. Unlinking
            // is what stops the directory — and this sweep's work — growing
            // without bound across restarts.
            //
            // Asked again rather than assumed: unlinking the socket of a
            // server that is still answering takes away the only name that
            // agent has, and nothing could ever attach to it again. A socket
            // is only rubbish once nothing replies on it.
            if tmux_answers(&tmux, &sock) {
                eprintln!("[core] {name} still answers after kill-server; left alone");
                continue;
            }
            let _ = std::fs::remove_file(e.path());
            eprintln!("[core] swept a held session with no card left: {name}");
        }
    }

    /// Where the opening-prompt template lives, written out on first use.
    ///
    /// The start-attempt dialog has always shown the composed prompt and let
    /// it be edited for that one attempt; this is the same text one level up,
    /// where editing it changes every attempt after. Surfacing the path is
    /// what turns "the app adds something to your session" from a fact buried
    /// in the README into a file the settings can open.
    pub fn prompt_template_path(&self) -> String {
        crate::prompt::template_path(&self.data_dir)
            .to_string_lossy()
            .to_string()
    }

    /// The installed Claude Code's version, as measured at startup.
    pub fn claude_version(&self) -> Option<String> {
        self.claude_version.map(|(a, b, c)| format!("{a}.{b}.{c}"))
    }

    /// Whether the installed claude supports session names and, with them,
    /// cross-session messaging between this desk's sessions.
    pub fn named_sessions(&self) -> bool {
        self.claude_version >= Some(NAMED_SESSIONS_SINCE)
    }

    /* ------------------------- notifications ----------------------- */

    pub fn notify_prefs(&self) -> NotifyPrefs {
        *self.notify_prefs.lock().unwrap()
    }

    pub fn set_notify_prefs(&self, prefs: NotifyPrefs) -> Result<()> {
        *self.notify_prefs.lock().unwrap() = prefs;
        self.store
            .set_setting(NOTIFY_PREFS_KEY, &serde_json::to_string(&prefs)?)
    }

    /// A notification fired on request, so the panel's toggles can be
    /// checked against the OS without waiting for an agent to block.
    ///
    /// `force`, because the person pressing the button is by definition
    /// focused on the window — the focus gate would swallow exactly the
    /// notification being tested.
    pub fn test_notification(&self) {
        let locale = self.locale.get();
        self.sink.emit(
            "notify",
            serde_json::json!({
                "title": crate::i18n::test_title(locale),
                "body": crate::i18n::test_body(locale),
                "force": true,
            }),
        );
    }

    /* ---------------------------- parked --------------------------- */

    /// Park: keep the work and the conversation, give back the ground.
    ///
    /// The branch and the checkpoint refs stay; the worktree, every session
    /// living in it — the attempt shell included — and the concurrency slot
    /// are returned. What is uncommitted rides a pre-park checkpoint across
    /// (a failure to keep it aborts the park: losing work silently is the
    /// one failure this feature must not have). Refused mid-turn, for
    /// exactly restore's reason. Returns the branch name, for the clipboard.
    pub fn park_attempt(&self, attempt_id: &str) -> Result<String> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            return Err(anyhow!("this attempt is finished — there is nothing left to park"));
        }
        if attempt.parked_at.is_some() {
            return Err(anyhow!("this attempt is already parked"));
        }
        let busy = self.sessions.lock().unwrap().values().any(|s| {
            s.attempt_id.as_deref() == Some(attempt_id)
                && s.live
                && !matches!(s.status, Status::Idle | Status::Saved | Status::Exited)
        });
        if busy {
            return Err(anyhow!(
                "the agent is mid-turn in this worktree. Parking now would pull the ground out \
                 from under its edits. Wait for the turn to end — or close the session — and \
                 park then"
            ));
        }

        // The shelf: whatever is uncommitted goes into a checkpoint the
        // worktree's removal cannot take with it.
        self.snapshot_attempt(attempt_id)?;

        let task = self.task(&attempt.task_id)?;
        let (wt_loc, he) = self.located(&attempt.worktree_path)?;
        let repo_loc = host::locate(&task.repo_path)?;

        // The sessions living in the directory go with it — the attempt's
        // own, the shell, a dev server — same rule as finishing.
        let doomed: Vec<String> = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| {
                s.attempt_id.as_deref() == Some(attempt_id)
                    || s.cwd == attempt.worktree_path
                    || s.cwd
                        .starts_with(&format!("{}/", attempt.worktree_path.trim_end_matches('/')))
            })
            .map(|s| s.id.clone())
            .collect();
        for id in doomed {
            self.ptys.kill(&id);
            let _ = self.store.archive_session(&id);
            self.sessions.lock().unwrap().remove(&id);
        }
        self.shells.lock().unwrap().remove(attempt_id);

        self.worktrees
            .remove(&he.hr(&self.env), &repo_loc.path, &wt_loc.path)?;
        self.store.set_parked(attempt_id, Some(now_ms() as i64))?;

        self.emit_tasks();
        self.broadcast();
        // The whole point: the slot is free now, and the queue should know.
        self.drain_queue();
        Ok(attempt.branch)
    }

    /// Resume: grow the ground back and walk the old road.
    ///
    /// The worktree reattaches to the attempt's branch at its recorded path
    /// — `--continue` finds the conversation by cwd, so the path is not
    /// negotiable — then the shelf checkpoint restores the exact content
    /// that was parked, and the existing reopen flow takes it from there.
    /// Attach succeeding *is* the resume; a restore failure afterwards is
    /// reported and retryable, never rolled back into fake cleanliness.
    pub fn resume_attempt(&self, attempt_id: &str, cols: u16, rows: u16) -> Result<Resumed> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            return Err(anyhow!("this attempt is finished; the frozen diff is its record"));
        }
        if attempt.parked_at.is_none() {
            return Err(anyhow!("this attempt is not parked"));
        }
        let task = self.task(&attempt.task_id)?;
        let (repo_loc, he) = self.located(&task.repo_path)?;
        let hr = he.hr(&self.env);
        let wt_path = host::locate(&attempt.worktree_path)?.path;

        self.worktrees
            .attach(&hr, &repo_loc.path, &wt_path, &attempt.branch)?;
        self.store.set_parked(attempt_id, None)?;

        // The shelf comes down before the agent looks: the branch tip may
        // be behind what was parked, and skipping this would lose work
        // quietly. Restore before any terminal exists — no one to race.
        let restore_error = (|| -> Result<()> {
            let cps = self.worktrees.checkpoints(&hr, &repo_loc.path, attempt_id)?;
            if let Some(cp) = cps.last() {
                self.worktrees.restore_checkpoint(&hr, &wt_path, &cp.sha)?;
            }
            Ok(())
        })()
        .err()
        .map(|e| format!("{e:#}"));

        let session_id = self.reopen_attempt(attempt_id, cols, rows)?;
        self.emit_tasks();
        Ok(Resumed {
            session_id,
            restore_error,
        })
    }

    /* ------------------------- checkpoints ------------------------- */

    pub fn checkpoints_enabled(&self) -> bool {
        *self.checkpoints_on.lock().unwrap()
    }

    pub fn set_checkpoints_enabled(&self, on: bool) -> Result<()> {
        *self.checkpoints_on.lock().unwrap() = on;
        self.store
            .set_setting(CHECKPOINTS_KEY, if on { "1" } else { "0" })
    }

    /// An attempt's checkpoints, oldest first — read straight off the refs.
    pub fn list_checkpoints(&self, attempt_id: &str) -> Result<Vec<crate::worktree::Checkpoint>> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            // Finished: the refs are gone by design, the frozen diff remains.
            return Ok(Vec::new());
        }
        // Parked has no worktree, but the refs live in the repo's shared
        // git dir — read them from the main checkout.
        if attempt.parked_at.is_some() {
            let task = self.task(&attempt.task_id)?;
            let (repo_loc, he) = self.located(&task.repo_path)?;
            return self
                .worktrees
                .checkpoints(&he.hr(&self.env), &repo_loc.path, attempt_id);
        }
        let (loc, he) = self.located(&attempt.worktree_path)?;
        self.worktrees
            .checkpoints(&he.hr(&self.env), &loc.path, attempt_id)
    }

    /// The manual checkpoint — any agent, any moment a human chooses.
    /// `None` means nothing changed since the last one (or one was already
    /// in flight, which amounts to the same snapshot).
    pub fn checkpoint_now(&self, attempt_id: &str) -> Result<Option<crate::worktree::Checkpoint>> {
        self.snapshot_attempt(attempt_id)
    }

    /// The Stop-hook path: leave immediately, snapshot on a thread of its
    /// own. `on_hook` is a path an agent is waiting on, and this is real
    /// git work.
    pub(crate) fn snapshot_after_turn(self: &Arc<Self>, session_id: &str) {
        if !self.checkpoints_enabled() {
            return;
        }
        let attempt_id = self
            .sessions
            .lock()
            .unwrap()
            .get(session_id)
            .and_then(|s| s.attempt_id.clone());
        let Some(attempt_id) = attempt_id else { return };
        let core = Arc::clone(self);
        std::thread::spawn(move || match core.snapshot_attempt(&attempt_id) {
            Ok(_) => {}
            Err(e) => eprintln!("[core] checkpoint for {attempt_id} failed: {e:#}"),
        });
    }

    /// The other thing a turn's end settles: the token account. Same seam
    /// as the snapshot, same shape — leave the hook path now, read on a
    /// thread of its own. Sessions with no recorded transcript (any agent
    /// that is not claude, or a claude too old to say) simply never appear
    /// in the books: honest absence, not a zero.
    pub(crate) fn usage_after_turn(self: &Arc<Self>, session_id: &str) {
        let (cwd, transcript) = {
            let sessions = self.sessions.lock().unwrap();
            let Some(s) = sessions.get(session_id) else { return };
            let Some(tp) = s.transcript_path.clone() else { return };
            (s.cwd.clone(), tp)
        };
        let core = Arc::clone(self);
        let sid = session_id.to_string();
        std::thread::spawn(move || {
            if let Err(e) = core.read_usage(&sid, &cwd, &transcript) {
                eprintln!("[core] usage read for {sid} failed: {e:#}");
            }
        });
    }

    /// Read what the transcript has grown since last time and fold it into
    /// the session's account. The offset only ever advances to a line
    /// boundary — a half-written line is the next read's problem.
    fn read_usage(&self, session_id: &str, cwd: &str, transcript: &str) -> Result<()> {
        let (_, he) = self.located(cwd)?;
        let hr = he.hr(&self.env);
        let from = self
            .usage_state
            .lock()
            .unwrap()
            .get(session_id)
            .map(|u| u.offset)
            .unwrap_or(0);
        let Some(bytes) = hr.read_from(transcript, from)? else {
            return Ok(());
        };
        let consumed = match bytes.iter().rposition(|b| *b == b'\n') {
            Some(i) => i + 1,
            None => return Ok(()),
        };
        let (delta, context) = parse_usage(&String::from_utf8_lossy(&bytes[..consumed]));
        let usage = {
            let mut states = self.usage_state.lock().unwrap();
            let st = states.entry(session_id.to_string()).or_default();
            st.offset = from + consumed as u64;
            st.acc.input += delta.input;
            st.acc.output += delta.output;
            st.acc.cache_read += delta.cache_read;
            st.acc.cache_write += delta.cache_write;
            if let Some(ctx) = context {
                st.acc.context = ctx;
            }
            st.acc
        };
        if let Some(s) = self.sessions.lock().unwrap().get_mut(session_id) {
            s.usage = Some(usage);
        }
        self.broadcast();
        Ok(())
    }

    fn snapshot_attempt(&self, attempt_id: &str) -> Result<Option<crate::worktree::Checkpoint>> {
        if !self.claim_checkpointing(attempt_id) {
            return Ok(None);
        }
        let result = self.snapshot_attempt_inner(attempt_id);
        self.checkpointing.lock().unwrap().remove(attempt_id);
        result
    }

    fn claim_checkpointing(&self, attempt_id: &str) -> bool {
        self.checkpointing
            .lock()
            .unwrap()
            .insert(attempt_id.to_string())
    }

    /// The snapshot itself — call only while holding the attempt's
    /// `checkpointing` claim.
    fn snapshot_attempt_inner(
        &self,
        attempt_id: &str,
    ) -> Result<Option<crate::worktree::Checkpoint>> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        // Finished has nothing left to snapshot; parked already holds its
        // shelf checkpoint and has no worktree to read.
        if attempt.outcome.is_some() || attempt.parked_at.is_some() {
            return Ok(None);
        }
        let (loc, he) = self.located(&attempt.worktree_path)?;
        let cp = self.worktrees.checkpoint(
            &he.hr(&self.env),
            &loc.path,
            attempt_id,
            &attempt.base_sha,
        )?;
        if let Some(cp) = &cp {
            self.sink.emit(
                "checkpoints:changed",
                serde_json::json!({ "attemptId": attempt_id, "n": cp.n }),
            );
        }
        Ok(cp)
    }

    /// Restore an attempt's worktree to checkpoint `n` — `0` is the
    /// attempt's base. Code only, the conversation is never touched, and the
    /// restore is itself restorable: a "now" snapshot is taken first.
    ///
    /// Refused while a turn is in flight. Restoring under a running agent
    /// would pull files out from under its edits, and it would go on
    /// believing in work that is no longer there — the decoupling the
    /// decision document rules out. Stopped, idle and exited sessions are
    /// the moments a person can honestly rewind.
    pub fn restore_checkpoint(&self, attempt_id: &str, n: u64) -> Result<Restored> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if attempt.outcome.is_some() {
            return Err(anyhow!(
                "this attempt is finished — its worktree is gone and the frozen diff is the record"
            ));
        }
        if attempt.parked_at.is_some() {
            return Err(anyhow!(
                "this attempt is parked — resume it first, then restore"
            ));
        }
        let busy = self.sessions.lock().unwrap().values().any(|s| {
            s.attempt_id.as_deref() == Some(attempt_id)
                && s.live
                && !matches!(s.status, Status::Idle | Status::Saved | Status::Exited)
        });
        if busy {
            return Err(anyhow!(
                "the agent is mid-turn in this worktree. Restoring now would pull files out from \
                 under its edits, and it would keep believing in work that is no longer there. \
                 Wait for the turn to end — or close the session — and restore then"
            ));
        }
        // One claim covers the pre-save and the restore: a Stop-triggered
        // snapshot arriving mid-restore must not capture a half-restored
        // tree as a checkpoint.
        if !self.claim_checkpointing(attempt_id) {
            return Err(anyhow!(
                "a checkpoint is being taken right now; try again in a moment"
            ));
        }
        let result = (|| {
            // The retreat from the retreat, kept before anything moves.
            let saved = self.snapshot_attempt_inner(attempt_id)?;
            let (loc, he) = self.located(&attempt.worktree_path)?;
            let hr = he.hr(&self.env);
            let to_sha = if n == 0 {
                attempt.base_sha.clone()
            } else {
                self.worktrees
                    .checkpoints(&hr, &loc.path, attempt_id)?
                    .into_iter()
                    .find(|c| c.n == n)
                    .map(|c| c.sha)
                    .ok_or_else(|| anyhow!("this attempt has no checkpoint #{n}"))?
            };
            self.worktrees.restore_checkpoint(&hr, &loc.path, &to_sha)?;
            self.sink.emit(
                "checkpoints:changed",
                serde_json::json!({ "attemptId": attempt_id }),
            );
            Ok(Restored { to_n: n, to_sha, saved })
        })();
        self.checkpointing.lock().unwrap().remove(attempt_id);
        result
    }

    /// Startup sweep: checkpoint refs belong to open attempts; anything else
    /// is a leftover from a run that ended without its cleanup. Local repos
    /// only — reaching a WSL or SSH repo would cost a host probe at startup,
    /// and their strays go when any of their attempts next closes.
    fn sweep_checkpoint_orphans(&self) {
        let live: std::collections::HashSet<String> = match self.store.open_attempts() {
            Ok(list) => list.into_iter().map(|a| a.id).collect(),
            Err(e) => {
                eprintln!("[core] checkpoint sweep skipped: {e:#}");
                return;
            }
        };
        let repos: std::collections::HashSet<String> = match self.store.list_tasks() {
            Ok(tasks) => tasks.into_iter().map(|t| t.repo_path).collect(),
            Err(e) => {
                eprintln!("[core] checkpoint sweep skipped: {e:#}");
                return;
            }
        };
        for repo in repos {
            let Ok(loc) = host::locate(&repo) else { continue };
            if loc.host != Host::Local {
                continue;
            }
            let hr = HostRef {
                host: &Host::Local,
                local: &self.env,
                env: &self.env,
            };
            if !hr.is_dir(&loc.path) {
                continue;
            }
            match self.worktrees.sweep_checkpoints(&hr, &loc.path, &live) {
                Ok(0) => {}
                Ok(n) => eprintln!("[core] swept {n} orphan checkpoint refs in {repo}"),
                Err(e) => eprintln!("[core] checkpoint sweep in {repo} failed: {e:#}"),
            }
        }
    }

    /* --------------------------- helpers --------------------------- */

    fn persist(&self, meta: &SessionMeta) {
        if let Err(e) = self.store.upsert_session(&meta.to_stored()) {
            eprintln!("[core] persisting session {} failed: {e}", meta.id);
        }
    }

    fn broadcast(&self) {
        let list = self.sessions();
        let waiting = list.iter().filter(|s| s.status.needs_you()).count();
        if let Ok(v) = serde_json::to_value(&list) {
            self.sink.emit("sessions:changed", v);
        }
        self.sink
            .emit("badge", serde_json::json!({ "count": waiting }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::StoredTab;

    /// CI 守門的第二半:找到的 claude 要真的答得出 `--version`,而且版本
    /// 字串解析得出來 ——「偵測到」不是檔案存在,是問得到話。跟著
    /// shell_env 的守門測試一起,由 AGENTDESK_EXPECT_CLAUDE=1 啟用。
    #[test]
    fn a_promised_real_claude_answers_the_version_probe() {
        if std::env::var("AGENTDESK_EXPECT_CLAUDE").as_deref() != Ok("1") {
            eprintln!("skip: AGENTDESK_EXPECT_CLAUDE != 1");
            return;
        }
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let env = rt.block_on(crate::shell_env::resolve());
        let v = rt.block_on(probe_claude_version(&env));
        assert!(v.is_some(), "claude --version did not run or did not parse");
        let (a, b, c) = v.unwrap();
        eprintln!("claude {a}.{b}.{c} answered the probe");
    }

    /// The transcript arithmetic, against real-shaped rows: totals count
    /// everything including sidechains, context follows only the main line,
    /// and a malformed row is skipped rather than zeroing the account.
    #[test]
    fn usage_totals_count_sidechains_but_context_follows_the_main_line() {
        let lines = [
            r#"{"type":"user","message":{"role":"user"}}"#,
            r#"{"type":"assistant","isSidechain":false,"message":{"usage":{"input_tokens":10,"output_tokens":100,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50}}}"#,
            "this line is not json",
            r#"{"type":"assistant","isSidechain":true,"message":{"usage":{"input_tokens":5,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
            r#"{"type":"assistant","message":{"usage":{"input_tokens":2,"output_tokens":30,"cache_read_input_tokens":2000,"cache_creation_input_tokens":8}}}"#,
        ]
        .join("\n");
        let (sum, ctx) = parse_usage(&lines);
        assert_eq!(sum.input, 17);
        assert_eq!(sum.output, 330, "the sidechain's spend is real spend");
        assert_eq!(sum.cache_read, 3000);
        assert_eq!(sum.cache_write, 58);
        // The last main-line row: 2 + 2000 + 8. The sidechain in between
        // must not have hijacked the context.
        assert_eq!(ctx, Some(2010));
    }

    #[test]
    fn a_transcript_with_no_assistant_rows_has_no_context_yet() {
        let (sum, ctx) = parse_usage(r#"{"type":"user","message":{}}"#);
        assert_eq!(sum, Usage::default());
        assert_eq!(ctx, None);
    }

    /// The invoke boundary check for the editable diff: everything a diff
    /// legitimately names passes; everything that would leave the worktree
    /// does not.
    #[test]
    fn worktree_relative_paths_are_told_from_escapes() {
        for ok in ["src/app.ts", "README.md", "a/b/c.rs", "weird..name.txt", "深/中文.md"] {
            assert!(ensure_worktree_relative(ok).is_ok(), "{ok} should pass");
        }
        for bad in [
            "",
            "/etc/passwd",
            "\\server\\share",
            "../outside.txt",
            "src/../../outside.txt",
            "src\\..\\..\\outside.txt",
            "C:/Windows/system32",
        ] {
            assert!(ensure_worktree_relative(bad).is_err(), "{bad} should be refused");
        }
    }

    fn tab(id: &str, slots: Vec<&str>) -> StoredTab {
        StoredTab {
            id: id.into(),
            name: id.into(),
            layout: DEFAULT_LAYOUT.into(),
            slots: slots.into_iter().map(|s| Some(s.to_string())).collect(),
            position: 0,
        }
    }

    fn ids(t: &StoredTab) -> Vec<&str> {
        t.slots.iter().filter_map(|s| s.as_deref()).collect()
    }

    /// The uniqueness rule, isolated from the app so it can be exercised
    /// without a running core: claiming a session must vacate it elsewhere.
    fn claim(tabs: &mut [StoredTab], id: &str, slots: Vec<Option<String>>) {
        let claimed: std::collections::HashSet<&str> =
            slots.iter().filter_map(|s| s.as_deref()).collect();
        for t in tabs.iter_mut() {
            if t.id == id {
                t.slots = slots.clone();
            } else {
                t.slots
                    .retain(|s| !s.as_deref().is_some_and(|x| claimed.contains(x)));
            }
        }
    }

    #[test]
    fn a_session_claimed_by_one_tab_leaves_every_other() {
        let mut tabs = vec![tab("a", vec!["s1", "s2"]), tab("b", vec![])];
        claim(&mut tabs, "b", vec![Some("s1".into())]);

        // s1 has one PTY and therefore one size; two tabs showing it would
        // resize it against each other on every switch.
        assert_eq!(ids(&tabs[0]), vec!["s2"]);
        assert_eq!(ids(&tabs[1]), vec!["s1"]);
    }

    /// Losing a session must close the gap rather than leave one. A blank
    /// position is indistinguishable from one the user emptied on purpose,
    /// and every rule that tried to tell them apart guessed wrong somewhere.
    #[test]
    fn a_claimed_session_leaves_no_hole_behind() {
        let mut tabs = vec![tab("a", vec!["s1", "s2", "s3"]), tab("b", vec![])];
        claim(&mut tabs, "b", vec![Some("s2".into())]);
        assert_eq!(ids(&tabs[0]), vec!["s1", "s3"]);
    }

    #[test]
    fn claiming_does_not_disturb_sessions_it_did_not_ask_for() {
        let mut tabs = vec![tab("a", vec!["s1", "s2"]), tab("b", vec![])];
        claim(&mut tabs, "b", vec![Some("s3".into())]);
        assert_eq!(ids(&tabs[0]), vec!["s1", "s2"]);
    }

    #[test]
    fn only_blocking_states_count_as_needing_you() {
        assert!(Status::WaitingPermission.needs_you());
        assert!(Status::WaitingInput.needs_you());
        // A finished turn is your move, but it is not blocking the agent, so
        // it must not raise a notification or a badge.
        assert!(!Status::Idle.needs_you());
        assert!(!Status::Running.needs_you());
        assert!(!Status::Saved.needs_you());
        assert!(!Status::Exited.needs_you());
    }

    /// The prompt goes last, after every option. `--plugin-dir` is appended
    /// by us, so building the vector in the obvious order — user args, then
    /// prompt, then ours — would put a positional argument in front of an
    /// option.
    #[test]
    fn the_prompt_is_the_last_argument_on_the_command_line() {
        let args = build_args(
            "claude",
            Vec::new(),
            Some("/data/plugin"),
            Some("[AgentDesk 任務] 修好登入\n\n多行的 prompt".into()),
        );
        assert_eq!(args[0], "--plugin-dir");
        assert_eq!(args[1], "/data/plugin");
        assert!(args[2].starts_with("[AgentDesk"));
        assert_eq!(args.len(), 3);
    }

    #[test]
    fn reopening_passes_continue_as_an_option_and_sends_no_prompt() {
        let args = build_args(
            "claude",
            vec!["--continue".to_string()],
            Some("/data/plugin"),
            None,
        );
        assert_eq!(args, vec!["--continue", "--plugin-dir", "/data/plugin"]);
    }

    /// A CLI that does not understand `--plugin-dir` must not be handed it:
    /// it would refuse to start, and status reporting is a nicety while the
    /// session itself is not.
    #[test]
    fn another_agent_is_not_handed_claude_codes_flags() {
        let args = build_args("codex", vec!["--model".into(), "o3".into()], Some("/p"), None);
        assert_eq!(args, vec!["--model", "o3"]);
    }

    /// The gate that keeps `--name` off an older CLI: unknown or old reads
    /// as "do not", because the flag stops that claude from starting at all.
    #[test]
    fn the_name_flag_is_gated_on_a_measured_version() {
        assert_eq!(parse_claude_version("2.1.226 (Claude Code)"), Some((2, 1, 226)));
        assert_eq!(parse_claude_version("10.0.0"), Some((10, 0, 0)));
        assert_eq!(parse_claude_version(""), None);
        assert_eq!(parse_claude_version("claude: command not found"), None);
        assert_eq!(parse_claude_version("2.1"), None);

        let since = Some(NAMED_SESSIONS_SINCE);
        assert!(Some((2, 1, 224)) >= since);
        assert!(Some((2, 2, 0)) >= since);
        assert!(Some((2, 1, 223)) < since, "one release short must stay off");
        assert!(None::<(u64, u64, u64)> < since, "unknown must stay off");
    }

    #[test]
    fn hook_states_map_onto_session_status() {
        assert_eq!(Status::from_hook(HookState::Running), Status::Running);
        assert_eq!(
            Status::from_hook(HookState::WaitingPermission),
            Status::WaitingPermission
        );
        assert_eq!(Status::from_hook(HookState::Idle), Status::Idle);
        assert_eq!(Status::from_hook(HookState::Ended), Status::Exited);
    }
}

/// Where tmux keeps its sockets: `$TMUX_TMPDIR` or `/tmp`, then `tmux-<uid>`.
///
/// Read rather than asked for, because the ids this desk has forgotten exist
/// nowhere else — `list-sessions` can only speak for a server you can already
/// name. Unix only, which costs nothing: the only worlds that hold sessions
/// are the ones with tmux, and Windows has none.
#[cfg(unix)]
/// Is anything still answering on this socket?
///
/// The one question both the startup check and the sweep ask, so they cannot
/// answer it differently. A failure to run tmux at all reads as "no" here,
/// which is the safe direction for the check and, in the sweep, is why the
/// unlink asks again rather than trusting a kill it may never have run.
fn tmux_answers(tmux: &std::path::Path, socket: &pty::Socket) -> bool {
    let (_, args) = pty::hold_alive(socket);
    std::process::Command::new(tmux)
        .args(&args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub fn tmux_socket_dir() -> Option<std::path::PathBuf> {
    let base = std::env::var("TMUX_TMPDIR").unwrap_or_else(|_| "/tmp".to_string());
    // SAFETY: getuid is always safe; it reads a process property and cannot fail.
    let uid = unsafe { libc_getuid() };
    Some(std::path::PathBuf::from(base).join(format!("tmux-{uid}")))
}

#[cfg(not(unix))]
pub fn tmux_socket_dir() -> Option<std::path::PathBuf> {
    None
}

/// The one libc call this crate needs, declared rather than adding a
/// dependency for a single symbol.
#[cfg(unix)]
extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}
