//! Per-repository configuration: `.marol/config.json`.
//!
//! A fresh worktree is a checkout, not a workspace — no `node_modules`, no
//! `.env`, nothing built. The agent can install its own dependencies, but it
//! should not have to rediscover how on every attempt, and the person should
//! not have to teach it. This file lets the repository say once how a
//! workspace becomes runnable:
//!
//! ```json
//! {
//!   "setup": "npm install && cp \"$MAROL_ROOT_PATH/.env\" .env",
//!   "run": [
//!     { "name": "dev", "command": "npm run dev -- --port $MAROL_PORT" }
//!   ],
//!   "archive": "docker compose down"
//! }
//! ```
//!
//! * `setup` runs in the worktree before the agent starts, in the same
//!   terminal, so what it prints is on the session's scrollback and a failure
//!   is visible where the person is already looking.
//! * `run` entries become buttons: each starts its own terminal in the
//!   attempt's worktree, with a free port in `MAROL_PORT`.
//! * `archive` runs just before the worktree is taken back — the place to
//!   stop containers or return anything the setup borrowed.
//!
//! Every script sees `MAROL_ROOT_PATH`: the repository the worktree was
//! opened from, which is where untracked files worth copying (`.env`) live.
//!
//! Scripts run through `sh -c`, so they are written exactly like a line in a
//! terminal. A malformed file is an error, not a shrug: a config that
//! silently did nothing would look identical to a setup that ran and left no
//! trace, and the difference is an afternoon of debugging.

use anyhow::{Context, Result};
use serde::Deserialize;
use std::path::Path;

pub const FILE: &str = ".marol/config.json";

/// The names a repository's config may wear, the one we write about first.
///
/// `.agentdesk/config.json` is still read, and not out of nostalgia: unlike
/// everything else this app renamed, that file is not ours. It lives inside
/// the person's repository, it is usually committed, and it is shared with
/// collaborators who may not run this desk at all. Renaming our own things
/// does not give us the right to break theirs, so the old name goes on
/// working and nothing has to be edited on our account.
pub const FILES: [&str; 2] = [FILE, ".agentdesk/config.json"];

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RepoConfig {
    /// Makes a fresh worktree runnable. One shell line; `&&` chains steps.
    #[serde(default)]
    pub setup: Option<String>,
    /// Long-running things a person starts on demand: dev server, test
    /// watcher, worker.
    #[serde(default)]
    pub run: Vec<RunScript>,
    /// Undoes whatever setup borrowed, just before the worktree goes back.
    #[serde(default)]
    pub archive: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RunScript {
    pub name: String,
    pub command: String,
}

/// Parse a config file's text. `what` names the file in the error, because
/// "expected string at line 3" without a path is a riddle, not a report.
pub fn parse(text: &str, what: &str) -> Result<RepoConfig> {
    serde_json::from_str(text).with_context(|| format!("parsing {what}"))
}

/// Read the repository's config, if it has one.
///
/// `None` when the file does not exist — most repositories will not have one,
/// and that is not a condition. A file that exists but cannot be parsed is an
/// error carried to whoever tried to use it, because a typo that quietly
/// disabled setup would surface as "the worktree is mysteriously broken".
/// The core reads non-local repositories through their host and calls
/// `parse` itself; this is the local convenience the tests use.
pub fn load(repo: &Path) -> Result<Option<RepoConfig>> {
    for name in FILES {
        let path = repo.join(name);
        match std::fs::read_to_string(&path) {
            Ok(t) => return Ok(Some(parse(&t, &path.display().to_string())?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("marol-cfg-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".marol")).unwrap();
        d
    }

    #[test]
    fn a_repo_without_a_config_is_simply_none() {
        let d = std::env::temp_dir().join(format!("marol-cfg-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(load(&d).unwrap(), None);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A repository that still says `.agentdesk/config.json` goes on working.
    ///
    /// This file is the one thing the rename touched that is not ours. It sits
    /// inside the person's repository, it is usually committed, and their
    /// colleagues may not run this desk at all. Our name changing is not a
    /// reason for their setup script to stop running — and a setup that
    /// silently stopped would present as "the worktree is mysteriously
    /// broken", the exact confusion this file exists to remove.
    #[test]
    fn a_repository_still_using_the_old_config_name_is_read() {
        let d = std::env::temp_dir().join(format!("marol-cfg-old-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join(".agentdesk")).unwrap();
        std::fs::write(
            d.join(".agentdesk/config.json"),
            r#"{"setup": "npm install"}"#,
        )
        .unwrap();
        assert_eq!(
            load(&d).unwrap().unwrap().setup.as_deref(),
            Some("npm install"),
        );

        // A repository carrying both is one that has been brought forward.
        // The new name is the one it means.
        std::fs::create_dir_all(d.join(".marol")).unwrap();
        std::fs::write(d.join(".marol/config.json"), r#"{"setup": "pnpm i"}"#).unwrap();
        assert_eq!(load(&d).unwrap().unwrap().setup.as_deref(), Some("pnpm i"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_full_config_round_trips() {
        let d = dir("full");
        std::fs::write(
            d.join(FILE),
            r#"{
              "setup": "npm install",
              "run": [{ "name": "dev", "command": "npm run dev -- --port $MAROL_PORT" }],
              "archive": "docker compose down"
            }"#,
        )
        .unwrap();
        let c = load(&d).unwrap().unwrap();
        assert_eq!(c.setup.as_deref(), Some("npm install"));
        assert_eq!(c.run.len(), 1);
        assert_eq!(c.run[0].name, "dev");
        assert_eq!(c.archive.as_deref(), Some("docker compose down"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn every_field_is_optional() {
        let d = dir("partial");
        std::fs::write(d.join(FILE), r#"{ "setup": "make deps" }"#).unwrap();
        let c = load(&d).unwrap().unwrap();
        assert_eq!(c.setup.as_deref(), Some("make deps"));
        assert!(c.run.is_empty());
        assert_eq!(c.archive, None);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A typo must be an error someone sees, not a config that silently does
    /// nothing — the second is indistinguishable from a broken worktree.
    #[test]
    fn a_malformed_config_is_an_error_not_a_shrug() {
        let d = dir("broken");
        std::fs::write(d.join(FILE), r#"{ "setup": ["not", "a", "string"] }"#).unwrap();
        let err = load(&d).expect_err("parse must fail");
        assert!(err.to_string().contains("config.json"), "{err}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Misspelling `run` as `runs` must not quietly drop every script.
    #[test]
    fn an_unknown_field_is_called_out_as_the_typo_it_is() {
        let d = dir("typo");
        std::fs::write(d.join(FILE), r#"{ "runs": [] }"#).unwrap();
        assert!(load(&d).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }
}
