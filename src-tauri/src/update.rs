//! Updating in place, and the three things that have to be settled first.
//!
//! The mechanism itself is the updater plugin's: it reads a signed manifest,
//! fetches the artifact for this platform, checks it against a public key
//! compiled into the binary, and swaps it. What lives here is everything that
//! is true of *this* app and would otherwise be discovered the hard way.
//!
//! 1. **The database only migrates forward.** A build refuses to open a
//!    database a newer one wrote, and says so rather than guessing at a shape
//!    it does not understand. That refusal is deliberate — losing a board
//!    quietly is worse — but it means an upgrade is a one-way door, and until
//!    now the advice to prop it open ("copy `marol.db` out first") was
//!    addressed to somebody standing at a download page. An in-app update
//!    removes that page and the moment to read it, so the copy is taken here
//!    instead, before anything is replaced.
//!
//! 2. **A restart is only cheap where something else is holding the agents.**
//!    A world that answered `tmux -V` detaches its sessions and hands them
//!    back; a world without one ends them. Native Windows is the whole of
//!    that second category and is not an edge case. So an update never
//!    decides on its own that now is a fine time to quit — see
//!    `core::Core::restart_cost`, which prices it in agents.
//!
//! 3. **Not every install owns the file it runs from.** An AppImage, a macOS
//!    bundle and a Windows installer can each replace themselves. A `.deb` or
//!    `.rpm` belongs to the package manager that put it there, and writing
//!    over it behind that manager's back leaves a machine whose package
//!    database and disk disagree. Those installs are told where the release
//!    is and left to their own tooling.
//!
//! Nothing here applies anything on its own. The check is the app's, the
//! decision is the person's — the same division the rest of this desk keeps
//! between a machine-composed message and the human who sends it.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// How long a check is good for. Long enough that opening the app ten times
/// in a day is one request, short enough that a fix published in the morning
/// is offered by the afternoon.
pub const CHECK_INTERVAL_SECS: u64 = 60 * 60 * 24;

/// Settings keys. Both live in the `settings` table beside every other
/// preference, so an off switch survives a restart the same way.
pub const ENABLED_KEY: &str = "update.enabled";
pub const LAST_CHECK_KEY: &str = "update.last_check";

/// Whether this build can replace the file it is running from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Install {
    /// A bundle that owns its own artifact: a macOS `.app`, a Windows
    /// installer, a Linux AppImage. Replacing it in place is the update.
    SelfContained,
    /// Put here by `dpkg` or `rpm`, which keeps its own record of every file
    /// it owns and their checksums. An in-app swap desynchronises that record
    /// and the next `apt upgrade` is where it surfaces, a long way from the
    /// action that caused it.
    PackageManaged,
}

/// Which of the two this is.
///
/// Only Linux has the question, and there it has a direct answer rather than
/// an inference: the AppImage runtime exports `APPIMAGE` (the path of the
/// image itself) into the process it starts, so a build that can see that
/// variable is running from an image that can be replaced, and one that
/// cannot was unpacked onto the filesystem by a package manager.
///
/// macOS and Windows are never package-managed in the sense that matters
/// here. Homebrew casks and winget both wrap the same self-contained bundle
/// this would replace, and both notice the version moved underneath them
/// rather than breaking on it.
pub fn install_kind() -> Install {
    if cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none() {
        Install::PackageManaged
    } else {
        Install::SelfContained
    }
}

/// The version this build is, straight from the crate metadata the release
/// workflow writes.
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Where the pre-update copy of the database goes.
///
/// Beside the database rather than in a directory of its own, and named for
/// the version being left rather than for the time: what somebody reaches for
/// this file to do is go back to a particular build, and `marol.db.before-…`
/// is a name that answers "which one is the one I want" without a timestamp
/// to decode.
pub fn snapshot_path(db: &Path, leaving: &str) -> PathBuf {
    let mut name = db.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".before-{leaving}"));
    db.with_file_name(name)
}

/// Compare two dotted versions numerically.
///
/// Not a string comparison, which is the bug this function exists to not
/// have: `"0.10.0" < "0.9.0"` is true of strings and false of versions, and
/// a desk whose version number is going to pass 0.9 would have started
/// refusing every update at exactly the release where it mattered.
///
/// Anything after the first three numbers is ignored rather than parsed. A
/// prerelease suffix is not something this endpoint serves — the rolling
/// nightly is marked prerelease and `releases/latest` does not return it —
/// so the alternative to ignoring it is inventing an ordering for a case
/// that cannot arrive.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    triple(candidate) > triple(current)
}

fn triple(v: &str) -> (u64, u64, u64) {
    let mut it = v
        .trim()
        .trim_start_matches('v')
        .split(['.', '-', '+'])
        .map(|p| p.parse::<u64>().unwrap_or(0));
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

/// A release worth offering, reduced to what the UI shows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    pub version: String,
    /// The release's own notes, when it published any.
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// Take the copy that makes the upgrade reversible.
///
/// Returns where it went, so the caller can say it rather than claim it. A
/// failure here stops the update: the whole point of the copy is the case
/// where the new version turns out to be the problem, and applying anyway
/// after failing to take it would be spending exactly the thing being
/// protected.
pub fn snapshot_db(store: &crate::store::Store, db: &Path, leaving: &str) -> Result<PathBuf> {
    let dest = snapshot_path(db, leaving);
    store
        .snapshot_to(&dest)
        .with_context(|| "the copy that makes this upgrade reversible could not be taken")?;
    Ok(dest)
}

/// Refuse an apply that would end agents nobody agreed to end.
///
/// Takes the count rather than `core::RestartCost` so this module stays a
/// leaf — the same reason `store.rs` reaches for nothing above it. The number
/// is computed where the sessions are; the ruling about it belongs here.
///
/// `acknowledged` is what a person clicking past the count sends back. It is
/// not a flag the UI sets to be rid of a dialog: the count is on screen when
/// they click, and this is the record that it was.
pub fn check_restart(lost: i64, acknowledged: bool) -> Result<()> {
    if lost > 0 && !acknowledged {
        return Err(anyhow!(
            "{lost} agent session(s) would end with this restart — nothing in \
             their world is holding them. Finish or close them and update \
             then, or update anyway if that is what you meant"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The comparison that a string would get wrong, at the exact release
    /// where it would start mattering. 0.9 → 0.10 is the next minor bump
    /// this project will make.
    #[test]
    fn ten_is_newer_than_nine() {
        assert!(is_newer("0.10.0", "0.9.0"));
        assert!(!is_newer("0.9.0", "0.10.0"));
        assert!(is_newer("1.0.0", "0.99.99"));
    }

    /// The manifest says `0.7.0` and a tag says `v0.7.0`. Both are the same
    /// version and neither is an update over itself.
    #[test]
    fn a_leading_v_is_not_a_version_difference() {
        assert!(!is_newer("v0.6.0", "0.6.0"));
        assert!(is_newer("v0.7.0", "0.6.0"));
    }

    #[test]
    fn the_same_version_is_not_an_update() {
        assert!(!is_newer("0.6.0", "0.6.0"));
    }

    /// A version this build cannot parse must not read as newer. Offering an
    /// update on the strength of a string nobody understood is the one
    /// outcome worse than offering none.
    #[test]
    fn nonsense_does_not_read_as_newer() {
        assert!(!is_newer("", "0.6.0"));
        assert!(!is_newer("not-a-version", "0.6.0"));
    }

    #[test]
    fn the_snapshot_is_named_for_the_version_being_left() {
        let p = snapshot_path(Path::new("/data/Marol/marol.db"), "0.6.0");
        assert_eq!(
            p,
            PathBuf::from("/data/Marol/marol.db.before-0.6.0"),
            "the name says which build it can be taken back to"
        );
    }

    /// The refusal exists to be overridable by a person who read it, and to
    /// be silent when there is nothing to refuse.
    #[test]
    fn only_unheld_agents_stop_an_apply() {
        assert!(
            check_restart(0, false).is_ok(),
            "agents a tmux hands back are not a cost"
        );

        assert!(check_restart(2, false).is_err());
        let msg = check_restart(2, false).unwrap_err().to_string();
        assert!(msg.contains('2'), "the refusal says how many: {msg}");
        assert!(
            check_restart(2, true).is_ok(),
            "a person who read the count can still go ahead"
        );
    }

    /// A `VACUUM INTO` copy is a whole database, not a file that happens to
    /// exist: it opens, and it has the rows.
    #[test]
    fn the_snapshot_is_a_readable_database() {
        let dir = std::env::temp_dir().join(format!("marol-snap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("marol.db");
        let store = crate::store::Store::open(&db).unwrap();
        store.set_setting("canary", "still here").unwrap();

        let dest = snapshot_db(&store, &db, "0.6.0").unwrap();
        assert!(dest.exists());

        let restored = crate::store::Store::open(&dest).unwrap();
        assert_eq!(
            restored.setting("canary").unwrap().as_deref(),
            Some("still here"),
            "the copy carries the rows, not just the schema"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Taking a second snapshot over the first is what a second update does,
    /// and "file exists" is not an answer anybody wants for it.
    #[test]
    fn a_snapshot_replaces_the_one_before_it() {
        let dir = std::env::temp_dir().join(format!("marol-snap2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("marol.db");
        let store = crate::store::Store::open(&db).unwrap();

        store.set_setting("round", "one").unwrap();
        snapshot_db(&store, &db, "0.6.0").unwrap();
        store.set_setting("round", "two").unwrap();
        let dest = snapshot_db(&store, &db, "0.6.0").unwrap();

        let restored = crate::store::Store::open(&dest).unwrap();
        assert_eq!(
            restored.setting("round").unwrap().as_deref(),
            Some("two"),
            "the second snapshot is the current database, not the stale one"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
