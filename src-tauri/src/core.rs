//! Transport-agnostic application core.
//!
//! A session is a real terminal running a real agent CLI. The core owns the
//! PTYs, the session list, its persistence, and the hook-reported status; it
//! knows nothing about Tauri and talks to the outside world through `UiSink`,
//! so the same core can later be driven by an axum websocket without being
//! rewritten.

use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::hooks::{self, Activity, HookHandler, HookReport, HookServer, HookState};
use crate::prompt::{self, Delivery};
use crate::pty::{PtyRegistry, PtySink};
use crate::shell_env::{self, ShellEnv};
use crate::store::{Lifecycle, Outcome, Store, StoredAttempt, StoredSession, StoredTab, StoredTask};
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
struct Router {
    sink: Arc<dyn UiSink>,
    /// The same cell the core holds, so a notification never has to upgrade
    /// the weak core reference just to know what language to speak.
    locale: Arc<crate::i18n::LocaleCell>,
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
        } = report;
        let status = Status::from_hook(state);
        let at = now_ms();
        let mut timeline: Vec<PendingEvent> = Vec::new();

        let notify = {
            let mut sessions = self.sessions.lock().unwrap();
            let Some(s) = sessions.get_mut(&session_id) else {
                // A hook from a session we do not track: a stale terminal from
                // a previous run of the app. Ignore it rather than inventing
                // a row for it.
                return;
            };
            s.reports_status = true;
            s.last_active_at = at;
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
            // that reports the same state twice does not notify twice.
            let entering = status.needs_you() && !s.status.needs_you();
            s.status = status;
            entering.then(|| (s.title.clone(), s.cwd.clone()))
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

        let router = Arc::new(Router {
            sink: Arc::clone(&sink),
            locale: Arc::clone(&locale),
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

        core.broadcast();
        core.emit_tabs();
        core.emit_tasks();
        // Every terminal died with the last run, so anything that was waiting
        // for a slot has one now.
        core.drain_queue();
        Ok(core)
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
        self.worktrees
            .check_repo(&self.env, std::path::Path::new(&repo_path), &base_branch)?;

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
        Ok(serde_json::json!({
            "prompt": text,
            // So the dialog can say plainly that this one will not be sent
            // for you, rather than letting you press a button that quietly
            // does nothing.
            "willSend": prompt::delivery_for(agent) == Delivery::Positional,
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

        let opened = self.open_attempt(task_id, agent, first_prompt, cols, rows)?;
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
        cols: u16,
        rows: u16,
    ) -> Result<OpenedAttempt> {
        let task = self.task(task_id)?;
        let repo = std::path::PathBuf::from(&task.repo_path);
        let seq = self.store.next_attempt_seq(task_id)?;
        let slug = worktree::slug(&task.title, &task.id);

        let wt = self
            .worktrees
            .create(&self.env, &repo, &task.base_branch, &slug, seq)?;

        // From here on a failure has a worktree to give back.
        let opened = self.finish_opening(&task, agent, first_prompt, &wt, cols, rows);
        if opened.is_err() {
            let _ = self.worktrees.remove(&self.env, &repo, &wt.path);
        }
        let opened = opened?;

        self.move_task(task_id, Lifecycle::Running, 0)?;
        self.emit_tasks();
        self.broadcast();
        Ok(opened)
    }

    fn finish_opening(
        &self,
        task: &StoredTask,
        agent: String,
        first_prompt: Option<String>,
        wt: &worktree::OpenedWorktree,
        cols: u16,
        rows: u16,
    ) -> Result<OpenedAttempt> {
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let cwd = wt.path.to_string_lossy().to_string();

        let text = match first_prompt {
            Some(edited) => edited,
            None => self.render_prompt(task, Some(wt))?,
        };

        let delivery = prompt::delivery_for(&agent);
        let positional = match delivery {
            Delivery::Positional => Some(text.clone()),
            Delivery::Manual => None,
        };

        let session_id = uuid::Uuid::new_v4().to_string();
        let at = now_ms();
        // A brand-new worktree always opens on the folder-trust prompt, and
        // no hook can report that. See `Status::AwaitingTrust`.
        let status = if delivery == Delivery::Positional {
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
        };

        // `--continue` is deliberately absent: this worktree has no history
        // for it to continue, and the prompt is what starts the work.
        self.launch(&session_id, &agent, Vec::new(), positional, &cwd, cols, rows)?;

        self.store.insert_attempt(&StoredAttempt {
            id: attempt_id.clone(),
            task_id: task.id.clone(),
            seq: wt.seq,
            agent,
            worktree_path: cwd.clone(),
            branch: wt.branch.clone(),
            base_sha: wt.base_sha.clone(),
            outcome: None,
            frozen_diff: None,
            created_at: at,
        })?;

        self.persist(&meta);
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), meta);

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
        if !std::path::Path::new(&attempt.worktree_path).is_dir() {
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
            vec!["--continue".to_string()]
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
        };
        self.launch(
            &session_id,
            &attempt.agent,
            opts,
            None,
            &attempt.worktree_path,
            cols,
            rows,
        )?;
        self.persist(&meta);
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.clone(), meta);
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
        let worktree = std::path::PathBuf::from(&attempt.worktree_path);

        // Best effort: a worktree that has already been deleted by hand must
        // not stop the attempt from being closed out.
        let diff = self
            .worktrees
            .diff(&self.env, &worktree, &attempt.base_sha)
            .ok();

        self.store
            .finish_attempt(&attempt.id, outcome, diff.as_deref())?;

        // The session goes with the directory it was running in.
        let session = self
            .sessions
            .lock()
            .unwrap()
            .values()
            .find(|s| s.attempt_id.as_deref() == Some(&attempt.id))
            .map(|s| s.id.clone());
        if let Some(id) = session {
            self.ptys.kill(&id);
            let _ = self.store.archive_session(&id);
            self.sessions.lock().unwrap().remove(&id);
        }

        if let Some(task) = task {
            self.worktrees.remove(
                &self.env,
                std::path::Path::new(&task.repo_path),
                &worktree,
            )?;
        }
        Ok(())
    }

    pub fn attempt_events(&self, attempt_id: &str) -> Result<Vec<crate::store::AttemptEvent>> {
        self.store.list_events(attempt_id)
    }

    /// The attempt's diff: live from the worktree while it still exists, and
    /// the frozen copy once it does not.
    pub fn attempt_diff(&self, attempt_id: &str) -> Result<String> {
        let attempt = self
            .store
            .get_attempt(attempt_id)?
            .ok_or_else(|| anyhow!("no such attempt: {attempt_id}"))?;
        if let Some(frozen) = attempt.frozen_diff {
            return Ok(frozen);
        }
        self.worktrees.diff(
            &self.env,
            std::path::Path::new(&attempt.worktree_path),
            &attempt.base_sha,
        )
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
                    .worktrees
                    .head_of(
                        &self.env,
                        std::path::Path::new(&task.repo_path),
                        &task.base_branch,
                    )
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

        let sha = self.worktrees.merge_to_base(
            &self.env,
            std::path::Path::new(&task.repo_path),
            std::path::Path::new(&attempt.worktree_path),
            &attempt.branch,
            &task.base_branch,
        )?;

        self.close_attempt(&attempt, Outcome::Merged)?;
        self.emit_tasks();
        self.broadcast();
        self.drain_queue();
        Ok(sha)
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
        self.worktrees.push_and_open_pr(
            &self.env,
            std::path::Path::new(&attempt.worktree_path),
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
        };

        self.launch(&id, &agent, extra_args, None, &cwd, cols, rows)?;

        self.persist(&meta);
        self.sessions.lock().unwrap().insert(id.clone(), meta);
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
        let args = if meta.agent == "claude" {
            vec!["--continue".to_string()]
        } else {
            Vec::new()
        };

        self.launch(id, &meta.agent, args, None, &meta.cwd, cols, rows)?;

        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.status = Status::Starting;
            s.live = true;
            s.last_active_at = now_ms();
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
    fn launch(
        &self,
        id: &str,
        agent: &str,
        opts: Vec<String>,
        positional: Option<String>,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        let mut extra_env = Vec::new();
        let plugin_dir = self.hooks.get().map(|server| {
            // Identity only: the listener URL is baked into the plugin at
            // startup, because the port changes every run.
            extra_env.push(("AGENTDESK_SESSION_ID".to_string(), id.to_string()));
            server.plugin_dir.to_string_lossy().to_string()
        });

        let args = build_args(agent, opts, plugin_dir.as_deref(), positional);

        self.ptys.spawn(
            id,
            agent,
            &args,
            cwd,
            &self.env,
            &extra_env,
            cols.max(20),
            rows.max(5),
            Arc::clone(&self.router) as Arc<dyn PtySink>,
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
    }

    pub fn sessions(&self) -> Vec<SessionMeta> {
        let mut v: Vec<_> = self.sessions.lock().unwrap().values().cloned().collect();
        v.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
        v
    }

    pub fn hook_url(&self) -> Option<String> {
        self.hooks.get().map(|h| h.url())
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
