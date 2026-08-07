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

pub fn default_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("AgentDesk")
        .join("agentdesk.db")
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

    fn migrate(&self) -> Result<()> {
        self.conn.lock().unwrap().execute_batch(
            r#"
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
            "#,
        )?;
        // Additive migration for databases written before completion existed.
        // `execute` errors when the column is already present; that is the
        // expected path on every run after the first, so it is ignored.
        let _ = self
            .conn
            .lock()
            .unwrap()
            .execute("ALTER TABLE sessions ADD COLUMN completed INTEGER NOT NULL DEFAULT 0", []);
        Ok(())
    }

    pub fn upsert_session(&self, s: &StoredSession) -> Result<()> {
        self.conn.lock().unwrap().execute(
            r#"INSERT INTO sessions (id, cwd, title, agent, created_at, last_active_at, archived, completed)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
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
            ],
        )?;
        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<StoredSession>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"SELECT id, cwd, title, agent, created_at, last_active_at, archived, completed
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
}

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
}
