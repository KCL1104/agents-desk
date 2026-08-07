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
use crate::pty::{PtyRegistry, PtySink};
use crate::shell_env::{self, ShellEnv};
use crate::store::{Store, StoredSession, StoredTab};

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
        matches!(self, Status::WaitingPermission | Status::WaitingInput)
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
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Routes PTY output onto the UI bus and keeps session status in step.
struct Router {
    sink: Arc<dyn UiSink>,
    sessions: Arc<Mutex<HashMap<String, SessionMeta>>>,
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
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.status = Status::Exited;
            s.live = false;
        }
        self.sink
            .emit("term:exit", serde_json::json!({ "id": id, "status": status }));
        self.broadcast();
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
        let notify = {
            let mut sessions = self.sessions.lock().unwrap();
            let Some(s) = sessions.get_mut(&session_id) else {
                // A hook from a session we do not track: a stale terminal from
                // a previous run of the app. Ignore it rather than inventing
                // a row for it.
                return;
            };
            s.reports_status = true;
            s.last_active_at = now_ms();

            // Only a tool call carries activity. A Stop or Notification report
            // has none, and must not blank out what the agent last did.
            if let Some(next) = activity {
                if s.activity.as_ref() != Some(&next) {
                    s.activity_since = now_ms();
                }
                s.activity = Some(next);
            }

            // Only announce a transition *into* needing a human, so a session
            // that reports the same state twice does not notify twice.
            let entering = status.needs_you() && !s.status.needs_you();
            s.status = status;
            entering.then(|| (s.title.clone(), s.cwd.clone()))
        };

        if let Some((title, cwd)) = notify {
            let body = match status {
                Status::WaitingPermission => "需要你授權才能繼續",
                _ => "在等你回覆",
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

pub struct Core {
    pub env: ShellEnv,
    store: Store,
    ptys: PtyRegistry,
    sessions: Arc<Mutex<HashMap<String, SessionMeta>>>,
    tabs: Mutex<Vec<StoredTab>>,
    sink: Arc<dyn UiSink>,
    router: Arc<Router>,
    hooks: OnceLock<HookServer>,
}

impl Core {
    pub async fn start(
        sink: Arc<dyn UiSink>,
        db_path: std::path::PathBuf,
        data_dir: std::path::PathBuf,
    ) -> Result<Arc<Self>> {
        let env = shell_env::resolve().await;
        let store = Store::open(&db_path)?;

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
                name: "工作區".to_string(),
                layout: DEFAULT_LAYOUT.to_string(),
                slots: Vec::new(),
                position: 0,
            };
            let _ = store.upsert_tab(&first);
            tabs.push(first);
        }

        let sessions = Arc::new(Mutex::new(restored));
        let router = Arc::new(Router {
            sink: Arc::clone(&sink),
            sessions: Arc::clone(&sessions),
        });

        let core = Arc::new(Self {
            env,
            store,
            ptys: PtyRegistry::new(),
            sessions,
            tabs: Mutex::new(tabs),
            sink: Arc::clone(&sink),
            router: Arc::clone(&router),
            hooks: OnceLock::new(),
        });

        // Status reporting is a nicety: if the listener cannot bind, sessions
        // still run, they just show no status.
        match hooks::start(&data_dir, router as Arc<dyn HookHandler>).await {
            Ok(server) => {
                let _ = core.hooks.set(server);
            }
            Err(e) => eprintln!("[core] status hooks unavailable: {e:#}"),
        }

        core.broadcast();
        core.emit_tabs();
        Ok(core)
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
        };

        self.launch(&id, &agent, extra_args, &cwd, cols, rows)?;

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

        self.launch(id, &meta.agent, args, &meta.cwd, cols, rows)?;

        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.status = Status::Starting;
            s.live = true;
            s.last_active_at = now_ms();
        }
        self.broadcast();
        Ok(())
    }

    /// Spawn the PTY, adding the status plugin and its identifying env.
    fn launch(
        &self,
        id: &str,
        agent: &str,
        mut args: Vec<String>,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<()> {
        let mut extra_env = Vec::new();

        if let Some(server) = self.hooks.get() {
            // Identity only: the listener URL is baked into the plugin at
            // startup, because the port changes every run.
            extra_env.push(("AGENTDESK_SESSION_ID".to_string(), id.to_string()));

            // Only Claude Code understands `--plugin-dir`; other CLIs run
            // without status reporting rather than failing to start.
            if agent == "claude" {
                args.push("--plugin-dir".to_string());
                args.push(server.plugin_dir.to_string_lossy().to_string());
            }
        }

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
        if let Some(s) = self.sessions.lock().unwrap().get_mut(id) {
            s.status = Status::Saved;
            s.live = false;
        }
        self.broadcast();
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
