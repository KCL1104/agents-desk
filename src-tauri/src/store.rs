//! SQLite persistence for the session list.
//!
//! Only metadata lives here — which directory, which agent, when it was last
//! used. Scrollback is deliberately not persisted: a terminal's scrollback is
//! ephemeral, and the agent's own conversation history already lives on disk
//! (`~/.claude/projects/...` for Claude Code), which is what `--continue`
//! reads when a session is reopened.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredSession {
    pub id: String,
    pub cwd: String,
    pub title: String,
    pub agent: String,
    pub created_at: u64,
    pub last_active_at: u64,
    pub archived: bool,
    /// Marked done by the user, not inferred. See `core::SessionMeta`.
    pub completed: bool,
    /// The attempt this session runs. `None` is an ad-hoc session — not every
    /// piece of work is worth a card.
    ///
    /// The link is stored here and nowhere else. Modelling a 1:1 relation from
    /// both ends lets the two ends disagree, and this is the end the hot path
    /// needs: a hook arrives knowing only its session id and has to find the
    /// attempt to file the event against.
    pub attempt_id: Option<String>,
}

/// A named working arrangement: which sessions are on screen and how they are
/// tiled. Slots are stored as JSON because they are one value conceptually —
/// a separate row per slot would buy a join and nothing else.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTab {
    pub id: String,
    pub name: String,
    pub layout: String,
    pub slots: Vec<Option<String>>,
    pub position: i64,
}

/// Where a task sits on the board. Moved by hand, only ever by hand: a `Stop`
/// hook means "this turn ended", never "the work is finished", so nothing the
/// agent reports may advance this. See `core::Status` for the other axis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Backlog,
    Running,
    Review,
    Done,
    Abandoned,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Backlog => "backlog",
            Self::Running => "running",
            Self::Review => "review",
            Self::Done => "done",
            Self::Abandoned => "abandoned",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "backlog" => Self::Backlog,
            "running" => Self::Running,
            "review" => Self::Review,
            "done" => Self::Done,
            "abandoned" => Self::Abandoned,
            _ => return None,
        })
    }
}

/// How an attempt ended. Setting one is terminal: the worktree is removed, so
/// the live TUI is gone and what remains is the timeline and the frozen diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Merged,
    Discarded,
    Superseded,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Merged => "merged",
            Self::Discarded => "discarded",
            Self::Superseded => "superseded",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "merged" => Self::Merged,
            "discarded" => Self::Discarded,
            "superseded" => Self::Superseded,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredTask {
    pub id: String,
    pub title: String,
    pub prompt: String,
    pub repo_path: String,
    pub base_branch: String,
    pub lifecycle: Lifecycle,
    /// Order within its column, the same plain integer the tab strip uses.
    pub position: i64,
    pub created_at: u64,
}

/// One go at a card with one agent, in its own worktree on its own branch.
/// Switching agent means a new attempt, not a restart of this one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredAttempt {
    pub id: String,
    pub task_id: String,
    /// Which try this is, for `<slug>-<n>`. Stored rather than counted, so a
    /// removed attempt never lets a later one reuse its branch name.
    pub seq: i64,
    pub agent: String,
    pub worktree_path: String,
    pub branch: String,
    /// The base commit at the moment the attempt opened — the diff baseline.
    pub base_sha: String,
    pub outcome: Option<Outcome>,
    /// `git diff` captured just before the worktree was removed. Once an
    /// outcome is set the worktree is gone, so this is the only way the diff
    /// survives for review.
    pub frozen_diff: Option<String>,
    pub created_at: u64,
}

/// One entry on an attempt's timeline: the prompt that started it, a tool the
/// agent reached for, or a status change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttemptEvent {
    pub id: i64,
    pub attempt_id: String,
    pub at: u64,
    pub kind: String,
    pub tool: Option<String>,
    pub detail: Option<String>,
}

pub fn default_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("AgentDesk")
        .join("agentdesk.db")
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Asked of the database rather than assumed from the version, because the
/// whole point of the adoption path is that version 0 does not tell us which
/// shape we are looking at.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Store {
    pub fn open(path: &PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        let store = Self {
            conn: Mutex::new(conn),
        };
        store.migrate()?;
        Ok(store)
    }

    #[cfg(test)]
    pub fn in_memory() -> Result<Self> {
        let store = Self {
            conn: Mutex::new(Connection::open_in_memory()?),
        };
        store.migrate()?;
        Ok(store)
    }

    /// The schema this build expects. Bump it and add a `V<n>` step below.
    const SCHEMA_VERSION: i64 = 2;

    /// Sessions and tabs: everything that existed before the schema was
    /// versioned.
    const V1: &'static str = r#"
        CREATE TABLE IF NOT EXISTS sessions (
            id              TEXT PRIMARY KEY,
            cwd             TEXT NOT NULL,
            title           TEXT NOT NULL,
            agent           TEXT NOT NULL DEFAULT 'claude',
            created_at      INTEGER NOT NULL,
            last_active_at  INTEGER NOT NULL,
            archived        INTEGER NOT NULL DEFAULT 0,
            completed       INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS sessions_by_activity
            ON sessions(archived, last_active_at DESC);

        CREATE TABLE IF NOT EXISTS tabs (
            id       TEXT PRIMARY KEY,
            name     TEXT NOT NULL,
            layout   TEXT NOT NULL DEFAULT '{"mode":"auto","cols":"auto"}',
            slots    TEXT NOT NULL DEFAULT '[]',
            position INTEGER NOT NULL DEFAULT 0
        );
    "#;

    /// The task layer: cards, the attempts made at them, and their timelines.
    const V2: &'static str = r#"
        CREATE TABLE tasks (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            prompt      TEXT NOT NULL,
            repo_path   TEXT NOT NULL,
            base_branch TEXT NOT NULL,
            lifecycle   TEXT NOT NULL,
            position    INTEGER NOT NULL,
            created_at  INTEGER NOT NULL
        );
        CREATE INDEX tasks_by_column ON tasks(lifecycle, position);

        CREATE TABLE attempts (
            id            TEXT PRIMARY KEY,
            task_id       TEXT NOT NULL,
            seq           INTEGER NOT NULL,
            agent         TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            branch        TEXT NOT NULL,
            base_sha      TEXT NOT NULL,
            outcome       TEXT,
            frozen_diff   TEXT,
            created_at    INTEGER NOT NULL
        );
        CREATE INDEX attempts_by_task ON attempts(task_id, seq);

        CREATE TABLE attempt_events (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            attempt_id TEXT NOT NULL,
            at         INTEGER NOT NULL,
            kind       TEXT NOT NULL,
            tool       TEXT,
            detail     TEXT
        );
        CREATE INDEX attempt_events_by_attempt ON attempt_events(attempt_id, at);

        ALTER TABLE sessions ADD COLUMN attempt_id TEXT;
        CREATE INDEX sessions_by_attempt ON sessions(attempt_id);
    "#;

    /// Bring the database up to `SCHEMA_VERSION`, one step at a time.
    ///
    /// The schema will keep moving from here, and the old best-effort
    /// `let _ = ALTER TABLE ...` could not carry that: it could not tell a
    /// column that was already there from one that failed to be added, so
    /// every future step would have had to be written as if it might silently
    /// not have happened.
    ///
    /// Each step runs in a transaction together with the version bump, so a
    /// failure leaves the database on the last version that fully applied
    /// rather than half-way into the next one.
    fn migrate(&self) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let mut version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;

        // Databases written before versioning existed sit at version 0 while
        // already having v1's shape — including `completed`, which the old
        // best-effort ALTER added. Replaying v1 over them would fail on the
        // duplicate column, and errors are no longer swallowed, so that would
        // take the app down on every existing install. Adopt them instead:
        // converge whatever they have onto v1, then stamp them.
        if version == 0 && table_exists(&conn, "sessions")? {
            if !column_exists(&conn, "sessions", "completed")? {
                conn.execute(
                    "ALTER TABLE sessions ADD COLUMN completed INTEGER NOT NULL DEFAULT 0",
                    [],
                )?;
            }
            conn.pragma_update(None, "user_version", 1)?;
            version = 1;
        }

        while version < Self::SCHEMA_VERSION {
            let next = version + 1;
            let step = match next {
                1 => Self::V1,
                2 => Self::V2,
                n => return Err(anyhow::anyhow!("no migration defined for version {n}")),
            };
            let tx = conn.transaction()?;
            tx.execute_batch(step)
                .with_context(|| format!("applying schema version {next}"))?;
            tx.pragma_update(None, "user_version", next)?;
            tx.commit()?;
            version = next;
        }

        // A database from a newer build has tables and columns this one does
        // not know about. Reading it is fine; writing to it is how data gets
        // lost, so say so plainly rather than corrupting it quietly.
        if version > Self::SCHEMA_VERSION {
            return Err(anyhow::anyhow!(
                "database is at schema version {version}, but this build understands {}. \
                 It was written by a newer AgentDesk.",
                Self::SCHEMA_VERSION
            ));
        }
        Ok(())
    }

    /// Insert a session, or refresh the fields that move.
    ///
    /// `attempt_id` is written on insert and never on update: which attempt a
    /// session belongs to is decided when it is created and is not something a
    /// later save may revise. Letting it be updated would mean any in-memory
    /// copy that had lost the link could quietly orphan the session from its
    /// card.
    pub fn upsert_session(&self, s: &StoredSession) -> Result<()> {
        self.conn.lock().unwrap().execute(
            r#"INSERT INTO sessions (id, cwd, title, agent, created_at, last_active_at, archived, completed, attempt_id)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT(id) DO UPDATE SET
                 title          = excluded.title,
                 last_active_at = excluded.last_active_at,
                 archived       = excluded.archived,
                 completed      = excluded.completed"#,
            params![
                s.id,
                s.cwd,
                s.title,
                s.agent,
                s.created_at as i64,
                s.last_active_at as i64,
                s.archived as i32,
                s.completed as i32,
                s.attempt_id,
            ],
        )?;
        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<StoredSession>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"SELECT id, cwd, title, agent, created_at, last_active_at, archived, completed, attempt_id
               FROM sessions WHERE archived = 0 ORDER BY last_active_at DESC"#,
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(StoredSession {
                    id: r.get(0)?,
                    cwd: r.get(1)?,
                    title: r.get(2)?,
                    agent: r.get(3)?,
                    created_at: r.get::<_, i64>(4)? as u64,
                    last_active_at: r.get::<_, i64>(5)? as u64,
                    archived: r.get::<_, i32>(6)? != 0,
                    completed: r.get::<_, i32>(7)? != 0,
                    attempt_id: r.get(8)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /* -------------------------------- tabs ------------------------- */

    pub fn list_tabs(&self) -> Result<Vec<StoredTab>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT id, name, layout, slots, position FROM tabs ORDER BY position")?;
        let rows = stmt
            .query_map([], |r| {
                let slots: String = r.get(3)?;
                Ok(StoredTab {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    layout: r.get(2)?,
                    slots: serde_json::from_str(&slots).unwrap_or_default(),
                    position: r.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn upsert_tab(&self, t: &StoredTab) -> Result<()> {
        let slots = serde_json::to_string(&t.slots)?;
        self.conn.lock().unwrap().execute(
            r#"INSERT INTO tabs (id, name, layout, slots, position)
               VALUES (?1, ?2, ?3, ?4, ?5)
               ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name, layout = excluded.layout,
                 slots = excluded.slots, position = excluded.position"#,
            params![t.id, t.name, t.layout, slots, t.position],
        )?;
        Ok(())
    }

    pub fn delete_tab(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("DELETE FROM tabs WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn archive_session(&self, id: &str) -> Result<()> {
        self.conn
            .lock()
            .unwrap()
            .execute("UPDATE sessions SET archived = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    /* -------------------------------- tasks ------------------------ */

    pub fn upsert_task(&self, t: &StoredTask) -> Result<()> {
        self.conn.lock().unwrap().execute(
            r#"INSERT INTO tasks (id, title, prompt, repo_path, base_branch, lifecycle, position, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
               ON CONFLICT(id) DO UPDATE SET
                 title       = excluded.title,
                 prompt      = excluded.prompt,
                 base_branch = excluded.base_branch,
                 lifecycle   = excluded.lifecycle,
                 position    = excluded.position"#,
            params![
                t.id,
                t.title,
                t.prompt,
                t.repo_path,
                t.base_branch,
                t.lifecycle.as_str(),
                t.position,
                t.created_at as i64,
            ],
        )?;
        Ok(())
    }

    /// Every card, in board order: column by column, and by `position` within
    /// each. The column order is fixed here rather than in SQL so the board
    /// cannot be reordered by a lexicographic accident.
    pub fn list_tasks(&self) -> Result<Vec<StoredTask>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"SELECT id, title, prompt, repo_path, base_branch, lifecycle, position, created_at
               FROM tasks ORDER BY position"#,
        )?;
        let mut rows = stmt
            .query_map([], |r| {
                let lifecycle: String = r.get(5)?;
                Ok(StoredTask {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    prompt: r.get(2)?,
                    repo_path: r.get(3)?,
                    base_branch: r.get(4)?,
                    // A row with an unreadable lifecycle still has to appear
                    // somewhere, or work would vanish from the board with no
                    // way to find it again. Backlog is the harmless column.
                    lifecycle: Lifecycle::parse(&lifecycle).unwrap_or(Lifecycle::Backlog),
                    position: r.get(6)?,
                    created_at: r.get::<_, i64>(7)? as u64,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.sort_by_key(|t| (COLUMN_ORDER.iter().position(|c| *c == t.lifecycle), t.position));
        Ok(rows)
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM attempt_events WHERE attempt_id IN (SELECT id FROM attempts WHERE task_id = ?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM attempts WHERE task_id = ?1", params![id])?;
        tx.execute("DELETE FROM tasks WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /* ------------------------------ attempts ----------------------- */

    /// The number the next attempt at this task should carry.
    ///
    /// Taken from the highest in use rather than from how many rows exist,
    /// because a finished attempt keeps its row and its branch: counting would
    /// hand out a number a superseded attempt is still holding.
    ///
    /// This is not proof against collision on its own. A branch outlives both
    /// the worktree and the row — delete a card and make another with the same
    /// title and the numbering starts over onto branches that still exist — so
    /// the worktree layer takes this as a starting point and walks past
    /// anything git already knows about.
    pub fn next_attempt_seq(&self, task_id: &str) -> Result<i64> {
        let n: i64 = self.conn.lock().unwrap().query_row(
            "SELECT coalesce(max(seq), 0) FROM attempts WHERE task_id = ?1",
            params![task_id],
            |r| r.get(0),
        )?;
        Ok(n + 1)
    }

    pub fn insert_attempt(&self, a: &StoredAttempt) -> Result<()> {
        self.conn.lock().unwrap().execute(
            r#"INSERT INTO attempts
                 (id, task_id, seq, agent, worktree_path, branch, base_sha, outcome, frozen_diff, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"#,
            params![
                a.id,
                a.task_id,
                a.seq,
                a.agent,
                a.worktree_path,
                a.branch,
                a.base_sha,
                a.outcome.map(|o| o.as_str()),
                a.frozen_diff,
                a.created_at as i64,
            ],
        )?;
        Ok(())
    }

    pub fn list_attempts(&self, task_id: &str) -> Result<Vec<StoredAttempt>> {
        self.query_attempts(
            r#"SELECT id, task_id, seq, agent, worktree_path, branch, base_sha, outcome, frozen_diff, created_at
               FROM attempts WHERE task_id = ?1 ORDER BY seq"#,
            params![task_id],
        )
    }

    pub fn get_attempt(&self, id: &str) -> Result<Option<StoredAttempt>> {
        Ok(self
            .query_attempts(
                r#"SELECT id, task_id, seq, agent, worktree_path, branch, base_sha, outcome, frozen_diff, created_at
                   FROM attempts WHERE id = ?1"#,
                params![id],
            )?
            .pop())
    }

    /// Attempts with no outcome yet — the ones still holding a worktree.
    pub fn open_attempts(&self) -> Result<Vec<StoredAttempt>> {
        self.query_attempts(
            r#"SELECT id, task_id, seq, agent, worktree_path, branch, base_sha, outcome, frozen_diff, created_at
               FROM attempts WHERE outcome IS NULL ORDER BY created_at"#,
            params![],
        )
    }

    fn query_attempts(
        &self,
        sql: &str,
        args: impl rusqlite::Params,
    ) -> Result<Vec<StoredAttempt>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt
            .query_map(args, |r| {
                let outcome: Option<String> = r.get(7)?;
                Ok(StoredAttempt {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    seq: r.get(2)?,
                    agent: r.get(3)?,
                    worktree_path: r.get(4)?,
                    branch: r.get(5)?,
                    base_sha: r.get(6)?,
                    outcome: outcome.as_deref().and_then(Outcome::parse),
                    frozen_diff: r.get(8)?,
                    created_at: r.get::<_, i64>(9)? as u64,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Close an attempt out, keeping the diff the worktree is about to take
    /// with it. Written together so an attempt can never end up finished with
    /// its evidence lost.
    pub fn finish_attempt(&self, id: &str, outcome: Outcome, diff: Option<&str>) -> Result<()> {
        let n = self.conn.lock().unwrap().execute(
            "UPDATE attempts SET outcome = ?2, frozen_diff = ?3 WHERE id = ?1",
            params![id, outcome.as_str(), diff],
        )?;
        if n == 0 {
            return Err(anyhow::anyhow!("no such attempt: {id}"));
        }
        Ok(())
    }

    /* --------------------------- timeline -------------------------- */

    pub fn append_event(
        &self,
        attempt_id: &str,
        at: u64,
        kind: &str,
        tool: Option<&str>,
        detail: Option<&str>,
    ) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "INSERT INTO attempt_events (attempt_id, at, kind, tool, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![attempt_id, at as i64, kind, tool, detail],
        )?;
        Ok(())
    }

    pub fn list_events(&self, attempt_id: &str) -> Result<Vec<AttemptEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, attempt_id, at, kind, tool, detail FROM attempt_events \
             WHERE attempt_id = ?1 ORDER BY at, id",
        )?;
        let rows = stmt
            .query_map(params![attempt_id], |r| {
                Ok(AttemptEvent {
                    id: r.get(0)?,
                    attempt_id: r.get(1)?,
                    at: r.get::<_, i64>(2)? as u64,
                    kind: r.get(3)?,
                    tool: r.get(4)?,
                    detail: r.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
}

/// Left to right on the board. `Abandoned` has no column — a card in it is
/// off the board entirely — but it is listed so the ordering is total.
pub const COLUMN_ORDER: [Lifecycle; 5] = [
    Lifecycle::Backlog,
    Lifecycle::Running,
    Lifecycle::Review,
    Lifecycle::Done,
    Lifecycle::Abandoned,
];

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, at: u64) -> StoredSession {
        StoredSession {
            id: id.into(),
            cwd: "/tmp/repo".into(),
            title: "repo".into(),
            agent: "claude".into(),
            created_at: at,
            last_active_at: at,
            archived: false,
            completed: false,
            attempt_id: None,
        }
    }

    #[test]
    fn sessions_round_trip() {
        let s = Store::in_memory().unwrap();
        s.upsert_session(&session("a", 1000)).unwrap();
        let listed = s.list_sessions().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].agent, "claude");
    }

    #[test]
    fn most_recently_active_comes_first() {
        let s = Store::in_memory().unwrap();
        s.upsert_session(&session("old", 1000)).unwrap();
        s.upsert_session(&session("new", 2000)).unwrap();
        let listed = s.list_sessions().unwrap();
        assert_eq!(listed[0].id, "new");
    }

    #[test]
    fn upsert_updates_activity_without_duplicating() {
        let s = Store::in_memory().unwrap();
        s.upsert_session(&session("a", 1000)).unwrap();
        let mut later = session("a", 1000);
        later.last_active_at = 5000;
        s.upsert_session(&later).unwrap();

        let listed = s.list_sessions().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].last_active_at, 5000);
        // created_at is immutable so the list can still show session age.
        assert_eq!(listed[0].created_at, 1000);
    }

    const LAYOUT: &str = r#"{"mode":"manual","root":{"dir":"row","kids":[{"id":"s1"},{"id":"s2"}],"fr":[0.7,0.3]}}"#;

    fn tab(id: &str, pos: i64) -> StoredTab {
        StoredTab {
            id: id.into(),
            name: "工作".into(),
            layout: LAYOUT.into(),
            slots: vec![Some("s1".into()), Some("s2".into())],
            position: pos,
        }
    }

    /// The layout is opaque to the store on purpose — it is a JSON document
    /// the frontend owns — so the thing worth testing is that it survives the
    /// round trip byte for byte rather than that it means anything here.
    #[test]
    fn tabs_round_trip_with_their_arrangement() {
        let s = Store::in_memory().unwrap();
        s.upsert_tab(&tab("t1", 0)).unwrap();
        let listed = s.list_tabs().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].layout, LAYOUT);
        assert_eq!(
            listed[0].slots,
            vec![Some("s1".to_string()), Some("s2".to_string())]
        );
    }

    #[test]
    fn tabs_come_back_in_their_placed_order() {
        let s = Store::in_memory().unwrap();
        s.upsert_tab(&tab("second", 1)).unwrap();
        s.upsert_tab(&tab("first", 0)).unwrap();
        let ids: Vec<_> = s.list_tabs().unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["first", "second"]);
    }

    #[test]
    fn a_corrupt_slot_payload_falls_back_to_an_empty_tab() {
        let s = Store::in_memory().unwrap();
        s.upsert_tab(&tab("t1", 0)).unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE tabs SET slots = 'not json' WHERE id = 't1'", [])
            .unwrap();
        // A tab that cannot be parsed must still open, empty, rather than
        // taking the whole tab strip down with it.
        assert!(s.list_tabs().unwrap()[0].slots.is_empty());
    }

    #[test]
    fn archived_sessions_leave_the_list() {
        let s = Store::in_memory().unwrap();
        s.upsert_session(&session("a", 1000)).unwrap();
        s.archive_session("a").unwrap();
        assert!(s.list_sessions().unwrap().is_empty());
    }

    /* ----------------------------- migration ----------------------- */

    fn scratch(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "agentdesk-store-{}-{name}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    /// Write a database the way the app did before the schema was versioned:
    /// v1's shape, `completed` present, and `user_version` still 0.
    fn legacy_db(path: &PathBuf, with_completed: bool) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (
                id              TEXT PRIMARY KEY,
                cwd             TEXT NOT NULL,
                title           TEXT NOT NULL,
                agent           TEXT NOT NULL DEFAULT 'claude',
                created_at      INTEGER NOT NULL,
                last_active_at  INTEGER NOT NULL,
                archived        INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE tabs (
                id       TEXT PRIMARY KEY,
                name     TEXT NOT NULL,
                layout   TEXT NOT NULL DEFAULT '{"mode":"auto","cols":"auto"}',
                slots    TEXT NOT NULL DEFAULT '[]',
                position INTEGER NOT NULL DEFAULT 0
            );
            "#,
        )
        .unwrap();
        if with_completed {
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN completed INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO sessions (id, cwd, title, agent, created_at, last_active_at, archived) \
             VALUES ('old', '/tmp/repo', 'repo', 'claude', 1000, 1000, 0)",
            [],
        )
        .unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    fn version_of(path: &PathBuf) -> i64 {
        Connection::open(path)
            .unwrap()
            .pragma_query_value(None, "user_version", |r| r.get(0))
            .unwrap()
    }

    /// The one that would have taken down every existing install: a
    /// pre-versioning database sits at version 0 but already has `completed`,
    /// so replaying v1 over it fails on the duplicate column — and unlike the
    /// old `let _ = ALTER ...`, that error is no longer swallowed.
    #[test]
    fn a_database_written_before_versioning_is_adopted_not_replayed() {
        let path = scratch("legacy");
        legacy_db(&path, true);

        let store = Store::open(&path).expect("an existing database must still open");

        assert_eq!(version_of(&path), Store::SCHEMA_VERSION);
        // The user's sessions are still there, not dropped and recreated.
        let listed = store.list_sessions().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "old");
        assert_eq!(listed[0].attempt_id, None);
        // And the new layer is usable on the same database.
        assert!(store.list_tasks().unwrap().is_empty());
        let _ = std::fs::remove_file(&path);
    }

    /// The other version-0 shape: old enough to predate `completed` entirely.
    /// Adoption has to converge it, not assume it.
    #[test]
    fn an_older_database_without_completed_is_brought_forward() {
        let path = scratch("older");
        legacy_db(&path, false);

        let store = Store::open(&path).expect("open");
        assert_eq!(version_of(&path), Store::SCHEMA_VERSION);
        assert!(!store.list_sessions().unwrap()[0].completed);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_fresh_database_lands_on_the_current_version() {
        let path = scratch("fresh");
        let store = Store::open(&path).unwrap();
        store.upsert_session(&session("a", 1000)).unwrap();
        assert_eq!(version_of(&path), Store::SCHEMA_VERSION);
        let _ = std::fs::remove_file(&path);
    }

    /// Every launch runs `migrate`. Applying an already-applied step must not
    /// be an error, or the app would open exactly once.
    #[test]
    fn reopening_a_migrated_database_changes_nothing() {
        let path = scratch("reopen");
        {
            let store = Store::open(&path).unwrap();
            store.upsert_session(&session("a", 1000)).unwrap();
        }
        let store = Store::open(&path).expect("second open");
        assert_eq!(version_of(&path), Store::SCHEMA_VERSION);
        assert_eq!(store.list_sessions().unwrap().len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    /// Downgrades are the case where best-effort migration loses data: the old
    /// build would happily write rows the new schema depends on. Refuse.
    #[test]
    fn a_database_from_a_newer_build_is_refused() {
        let path = scratch("newer");
        Store::open(&path).unwrap();
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 99i64)
            .unwrap();

        let err = match Store::open(&path) {
            Ok(_) => panic!("a newer schema must not be opened blindly"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("newer AgentDesk"),
            "unhelpful error: {err}"
        );
        let _ = std::fs::remove_file(&path);
    }

    /* ------------------------- tasks and attempts ------------------ */

    fn task(id: &str, lifecycle: Lifecycle, position: i64) -> StoredTask {
        StoredTask {
            id: id.into(),
            title: "修好登入".into(),
            prompt: "登入頁在 Safari 會白畫面".into(),
            repo_path: "/tmp/repo".into(),
            base_branch: "main".into(),
            lifecycle,
            position,
            created_at: 1000,
        }
    }

    fn attempt(id: &str, task_id: &str, seq: i64) -> StoredAttempt {
        StoredAttempt {
            id: id.into(),
            task_id: task_id.into(),
            seq,
            agent: "claude".into(),
            worktree_path: format!("/tmp/wt/{id}"),
            branch: format!("agentdesk/login-{seq}"),
            base_sha: "2bc172c2deadbeef".into(),
            outcome: None,
            frozen_diff: None,
            created_at: 1000 + seq as u64,
        }
    }

    #[test]
    fn tasks_round_trip_with_their_lifecycle() {
        let s = Store::in_memory().unwrap();
        s.upsert_task(&task("t1", Lifecycle::Review, 0)).unwrap();
        let listed = s.list_tasks().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].lifecycle, Lifecycle::Review);
        assert_eq!(listed[0].title, "修好登入");
    }

    /// The board reads left to right, and within a column by `position`.
    #[test]
    fn tasks_come_back_in_board_order() {
        let s = Store::in_memory().unwrap();
        s.upsert_task(&task("done", Lifecycle::Done, 0)).unwrap();
        s.upsert_task(&task("run-b", Lifecycle::Running, 1)).unwrap();
        s.upsert_task(&task("backlog", Lifecycle::Backlog, 0)).unwrap();
        s.upsert_task(&task("run-a", Lifecycle::Running, 0)).unwrap();

        let ids: Vec<_> = s.list_tasks().unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["backlog", "run-a", "run-b", "done"]);
    }

    /// A lifecycle this build does not recognise must not hide the card.
    #[test]
    fn a_task_with_an_unreadable_lifecycle_still_appears() {
        let s = Store::in_memory().unwrap();
        s.upsert_task(&task("t1", Lifecycle::Running, 0)).unwrap();
        s.conn
            .lock()
            .unwrap()
            .execute("UPDATE tasks SET lifecycle = 'quantum' WHERE id = 't1'", [])
            .unwrap();
        assert_eq!(s.list_tasks().unwrap()[0].lifecycle, Lifecycle::Backlog);
    }

    #[test]
    fn attempts_are_listed_per_task_in_order() {
        let s = Store::in_memory().unwrap();
        s.upsert_task(&task("t1", Lifecycle::Running, 0)).unwrap();
        s.upsert_task(&task("t2", Lifecycle::Running, 1)).unwrap();
        s.insert_attempt(&attempt("a2", "t1", 2)).unwrap();
        s.insert_attempt(&attempt("a1", "t1", 1)).unwrap();
        s.insert_attempt(&attempt("b1", "t2", 1)).unwrap();

        let ids: Vec<_> = s.list_attempts("t1").unwrap().into_iter().map(|a| a.id).collect();
        assert_eq!(ids, vec!["a1", "a2"]);
    }

    /// A finished attempt keeps its branch, so it must keep its number too.
    /// This is the case the board actually produces: switching agent
    /// supersedes attempt 1 and opens attempt 2 beside it.
    #[test]
    fn a_finished_attempt_still_holds_its_number() {
        let s = Store::in_memory().unwrap();
        s.upsert_task(&task("t1", Lifecycle::Running, 0)).unwrap();
        assert_eq!(s.next_attempt_seq("t1").unwrap(), 1);

        s.insert_attempt(&attempt("a1", "t1", 1)).unwrap();
        s.finish_attempt("a1", Outcome::Superseded, None).unwrap();

        // `agentdesk/login-1` still exists in git even though its worktree is
        // gone, so counting live attempts here would collide with it.
        assert_eq!(s.next_attempt_seq("t1").unwrap(), 2);
    }

    /// Numbering is per card, not global.
    #[test]
    fn attempt_numbers_are_counted_within_their_own_task() {
        let s = Store::in_memory().unwrap();
        s.upsert_task(&task("t1", Lifecycle::Running, 0)).unwrap();
        s.upsert_task(&task("t2", Lifecycle::Running, 1)).unwrap();
        s.insert_attempt(&attempt("a1", "t1", 1)).unwrap();
        s.insert_attempt(&attempt("a2", "t1", 2)).unwrap();

        assert_eq!(s.next_attempt_seq("t1").unwrap(), 3);
        assert_eq!(s.next_attempt_seq("t2").unwrap(), 1);
    }

    /// Setting an outcome removes the worktree, so the diff has to be captured
    /// in the same breath or the evidence goes with it.
    #[test]
    fn finishing_an_attempt_keeps_the_diff_the_worktree_takes_away() {
        let s = Store::in_memory().unwrap();
        s.upsert_task(&task("t1", Lifecycle::Running, 0)).unwrap();
        s.insert_attempt(&attempt("a1", "t1", 1)).unwrap();

        let diff = "diff --git a/src/auth.py b/src/auth.py\n@@ -1 +1 @@\n-old\n+new\n";
        s.finish_attempt("a1", Outcome::Merged, Some(diff)).unwrap();

        let got = s.get_attempt("a1").unwrap().unwrap();
        assert_eq!(got.outcome, Some(Outcome::Merged));
        assert_eq!(got.frozen_diff.as_deref(), Some(diff));
        // And it is no longer holding a worktree.
        assert!(s.open_attempts().unwrap().is_empty());
    }

    #[test]
    fn finishing_an_attempt_that_does_not_exist_is_an_error() {
        let s = Store::in_memory().unwrap();
        assert!(s.finish_attempt("ghost", Outcome::Merged, None).is_err());
    }

    #[test]
    fn the_timeline_comes_back_in_the_order_it_happened() {
        let s = Store::in_memory().unwrap();
        s.upsert_task(&task("t1", Lifecycle::Running, 0)).unwrap();
        s.insert_attempt(&attempt("a1", "t1", 1)).unwrap();

        s.append_event("a1", 100, "prompt", None, Some("修好登入")).unwrap();
        s.append_event("a1", 200, "tool", Some("Bash"), Some("pytest -v")).unwrap();
        // Two events in the same millisecond still have a defined order.
        s.append_event("a1", 200, "tool", Some("Edit"), Some("/repo/auth.py")).unwrap();

        let events = s.list_events("a1").unwrap();
        let tools: Vec<_> = events.iter().map(|e| e.tool.as_deref()).collect();
        assert_eq!(tools, vec![None, Some("Bash"), Some("Edit")]);
        assert_eq!(events[0].kind, "prompt");
    }

    /// A session belongs to an attempt from birth. Letting a later save revise
    /// that would let an in-memory copy that lost the link orphan the card.
    #[test]
    fn a_sessions_attempt_is_fixed_when_it_is_created() {
        let s = Store::in_memory().unwrap();
        let mut bound = session("s1", 1000);
        bound.attempt_id = Some("a1".into());
        s.upsert_session(&bound).unwrap();

        let mut forgetful = bound.clone();
        forgetful.attempt_id = None;
        forgetful.last_active_at = 5000;
        s.upsert_session(&forgetful).unwrap();

        let listed = s.list_sessions().unwrap();
        assert_eq!(listed[0].attempt_id.as_deref(), Some("a1"));
        assert_eq!(listed[0].last_active_at, 5000);
    }

    /// Deleting a card must not leave its attempts and their timelines behind
    /// as rows nothing can reach.
    #[test]
    fn deleting_a_task_takes_its_attempts_and_timeline_with_it() {
        let s = Store::in_memory().unwrap();
        s.upsert_task(&task("t1", Lifecycle::Running, 0)).unwrap();
        s.insert_attempt(&attempt("a1", "t1", 1)).unwrap();
        s.append_event("a1", 100, "tool", Some("Bash"), None).unwrap();

        s.delete_task("t1").unwrap();
        assert!(s.list_tasks().unwrap().is_empty());
        assert!(s.list_attempts("t1").unwrap().is_empty());
        assert!(s.list_events("a1").unwrap().is_empty());
    }
}
