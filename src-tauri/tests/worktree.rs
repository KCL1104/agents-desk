//! Worktree isolation, against real git.
//!
//! The properties here are the ones that decide whether running two agents on
//! one repository is real or only looks real: that the two never see each
//! other's files, that each diffs against the commit it actually started
//! from, and that the disk is given back afterwards.
//!
//!     cargo test --test worktree -- --nocapture

use std::path::{Path, PathBuf};

#[path = "../src/host.rs"]
mod host;
#[path = "../src/shell_env.rs"]
mod shell_env;
#[path = "../src/worktree.rs"]
mod worktree;

use crate::host::{Host, HostRef};
use crate::shell_env::ShellEnv;
use crate::worktree::{slug, Worktrees};

fn env() -> ShellEnv {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(shell_env::resolve())
}

/// These tests exercise the git layer itself, on the machine they run on.
static LOCAL: Host = Host::Local;

fn hr(env: &ShellEnv) -> HostRef<'_> {
    HostRef {
        host: &LOCAL,
        local: env,
        env,
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git must be installed");
    assert!(
        out.status.success(),
        "git {args:?} in {} failed: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// A repository with one commit on `main`, plus a worktree root beside it.
struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    trees: Worktrees,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "agentdesk-wt-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let repo = root.join("repo");
        std::fs::create_dir_all(&repo).unwrap();

        git(&repo, &["init", "-b", "main", "-q"]);
        git(&repo, &["config", "user.email", "t@agentdesk.test"]);
        git(&repo, &["config", "user.name", "AgentDesk Test"]);
        std::fs::write(repo.join("app.txt"), "one\n").unwrap();
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-qm", "first"]);

        let trees = Worktrees::new(root.join("worktrees"));
        Self { root, repo, trees }
    }

    fn repo_s(&self) -> String {
        self.repo.to_string_lossy().to_string()
    }

    fn head(&self) -> String {
        git(&self.repo, &["rev-parse", "HEAD"])
    }

    fn commit_on_main(&self, contents: &str) {
        std::fs::write(self.repo.join("app.txt"), contents).unwrap();
        git(&self.repo, &["add", "-A"]);
        git(&self.repo, &["commit", "-qm", "another"]);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// The point of the whole layer: two agents on one repository, at once,
/// without either seeing what the other is doing.
#[test]
fn two_attempts_on_one_repository_do_not_see_each_other() {
    let env = env();
    let f = Fixture::new("isolation");

    let a = f
        .trees
        .create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "login", 1)
        .expect("first attempt");
    let b = f
        .trees
        .create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "login", 2)
        .expect("second attempt");

    assert_ne!(a.path, b.path);
    assert_eq!(a.branch, "agentdesk/login-1");
    assert_eq!(b.branch, "agentdesk/login-2");

    // Each agent writes in its own tree.
    std::fs::write(Path::new(&a.path).join("app.txt"), "from attempt one\n").unwrap();
    std::fs::write(Path::new(&a.path).join("only-in-a.txt"), "a\n").unwrap();
    std::fs::write(Path::new(&b.path).join("app.txt"), "from attempt two\n").unwrap();

    assert_eq!(
        std::fs::read_to_string(Path::new(&b.path).join("app.txt")).unwrap(),
        "from attempt two\n",
        "one attempt's edit reached the other's tree"
    );
    assert!(
        !Path::new(&b.path).join("only-in-a.txt").exists(),
        "a file created in one attempt appeared in the other"
    );
    // And the repository the person actually works in is untouched.
    assert_eq!(
        std::fs::read_to_string(f.repo.join("app.txt")).unwrap(),
        "one\n",
        "an attempt wrote into the main checkout"
    );
}

/// `main` keeps moving. An attempt has to diff against the commit it started
/// from, or its diff picks up everything that landed on the base afterwards
/// and stops being a description of what the agent did.
#[test]
fn each_attempt_records_the_base_it_actually_started_from() {
    let env = env();
    let f = Fixture::new("basesha");

    let first_base = f.head();
    let a = f.trees.create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 1).unwrap();
    assert_eq!(a.base_sha, first_base);

    f.commit_on_main("two\n");
    let second_base = f.head();
    assert_ne!(first_base, second_base);

    let b = f.trees.create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 2).unwrap();
    assert_eq!(b.base_sha, second_base);
    // The first attempt's baseline did not move under it.
    assert_eq!(a.base_sha, first_base);
}

/// Skipping cleanup is how the disk fills up, so the removal has to work even
/// in the case that provokes it: an attempt abandoned with work still in the
/// tree.
#[test]
fn removing_a_worktree_gives_the_disk_back_and_keeps_the_branch() {
    let env = env();
    let f = Fixture::new("cleanup");

    let a = f.trees.create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 1).unwrap();
    std::fs::write(Path::new(&a.path).join("app.txt"), "uncommitted\n").unwrap();
    std::fs::write(Path::new(&a.path).join("scratch.txt"), "junk\n").unwrap();
    assert!(Path::new(&a.path).exists());

    f.trees.remove(&hr(&env), &f.repo_s(), &a.path).expect("remove");

    assert!(!Path::new(&a.path).exists(), "the worktree directory is still on disk");
    let listed = git(&f.repo, &["worktree", "list"]);
    assert!(
        !listed.contains(&a.path),
        "git still lists the worktree: {listed}"
    );
    // The branch is what a merged attempt was merged from; it stays.
    assert!(
        git(&f.repo, &["branch", "--list", "agentdesk/card-1"]).contains("agentdesk/card-1"),
        "removing the worktree took the branch with it"
    );
}

#[test]
fn removing_a_worktree_whose_directory_is_already_gone_still_tidies_up() {
    let env = env();
    let f = Fixture::new("gonedir");

    let a = f.trees.create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 1).unwrap();
    // Deleted by hand, or an external volume that did not come back.
    std::fs::remove_dir_all(&a.path).unwrap();

    f.trees
        .remove(&hr(&env), &f.repo_s(), &a.path)
        .expect("a missing directory must not make cleanup fail");
    let listed = git(&f.repo, &["worktree", "list"]);
    assert!(!listed.contains("card-1"), "stale entry left behind: {listed}");
}

/// A branch outlives the row that recorded it. Delete a card, make another
/// with the same title, and numbering starts over onto branches git still
/// has — so the numbering has to walk past them rather than fail.
#[test]
fn a_branch_git_already_has_is_walked_past() {
    let env = env();
    let f = Fixture::new("collision");

    git(&f.repo, &["branch", "agentdesk/card-1"]);
    git(&f.repo, &["branch", "agentdesk/card-2"]);

    let a = f
        .trees
        .create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 1)
        .expect("must not fail on an occupied name");
    assert_eq!(a.branch, "agentdesk/card-3");
    assert_eq!(a.seq, 3, "the number actually taken has to be reported back");
}

/// End to end for the case the slug rules exist for: git has to accept the
/// branch name a Chinese title produces.
#[test]
fn a_title_with_no_ascii_still_produces_a_branch_git_accepts() {
    let env = env();
    let f = Fixture::new("cjk");

    let s = slug("修好登入頁面的白畫面", "9f8e7d6c-4b2a");
    let a = f
        .trees
        .create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", &s, 1)
        .expect("git rejected the branch name");

    assert_eq!(a.branch, "agentdesk/task-9f8e7d6c-1");
    assert!(Path::new(&a.path).exists());
    assert_eq!(
        git(Path::new(&a.path), &["rev-parse", "--abbrev-ref", "HEAD"]),
        "agentdesk/task-9f8e7d6c-1"
    );
}

/// `git diff` alone knows nothing about files that were never added, and
/// creating files is most of what an agent does. A diff that omits them
/// cannot answer the question the diff tab exists to answer.
#[test]
fn the_diff_shows_files_the_agent_created_as_well_as_ones_it_edited() {
    let env = env();
    let f = Fixture::new("diff");

    let a = f.trees.create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 1).unwrap();
    std::fs::write(Path::new(&a.path).join("app.txt"), "edited by the agent\n").unwrap();
    std::fs::write(Path::new(&a.path).join("brand_new.rs"), "fn main() {}\n").unwrap();

    let diff = f.trees.diff(&hr(&env), &a.path, &a.base_sha).expect("diff");

    assert!(diff.contains("edited by the agent"), "the edit is missing:\n{diff}");
    assert!(
        diff.contains("brand_new.rs"),
        "a file the agent created is missing from the diff:\n{diff}"
    );
    assert!(
        diff.contains("fn main() {}"),
        "the new file's contents are missing:\n{diff}"
    );
}

/// Committed work has to stay in the diff too — the prompt asks the agent to
/// commit, and the diff is against the base, not against HEAD.
#[test]
fn the_diff_covers_committed_and_uncommitted_work_together() {
    let env = env();
    let f = Fixture::new("committed");

    let a = f.trees.create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 1).unwrap();
    std::fs::write(Path::new(&a.path).join("done.txt"), "committed work\n").unwrap();
    git(Path::new(&a.path), &["add", "-A"]);
    git(Path::new(&a.path), &["commit", "-qm", "agent's commit"]);
    std::fs::write(Path::new(&a.path).join("app.txt"), "still in progress\n").unwrap();

    let diff = f.trees.diff(&hr(&env), &a.path, &a.base_sha).unwrap();
    assert!(diff.contains("committed work"), "committed work missing:\n{diff}");
    assert!(diff.contains("still in progress"), "uncommitted work missing:\n{diff}");
}

/* ---------------------------- preconditions ---------------------------- */

#[test]
fn a_directory_that_is_not_a_repository_is_refused_up_front() {
    let env = env();
    let dir = std::env::temp_dir().join(format!("agentdesk-notrepo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let trees = Worktrees::new(dir.join("worktrees"));

    let err = trees
        .check_repo(&hr(&env), &dir.to_string_lossy(), "main")
        .expect_err("a plain directory must not be accepted as a repository");
    assert!(
        err.to_string().contains("not a git repository"),
        "unhelpful error: {err}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_base_branch_that_does_not_exist_is_refused_up_front() {
    let env = env();
    let f = Fixture::new("nobranch");

    let err = f
        .trees
        .check_repo(&hr(&env), &f.repo_s(), "develop")
        .expect_err("a missing base branch must be caught when the card is made");
    assert!(
        err.to_string().contains("no branch `develop`"),
        "unhelpful error: {err}"
    );
    // And nothing was created on the way to finding out.
    assert!(!Path::new(&f.trees.local_root()).exists());
}

/* --------------------------- checkpoints ---------------------------- */

/// The philosophy acceptance from the decision document: a checkpoint
/// produces a ref, and the agent's own `git status` — worktree, index,
/// branch — reads exactly the same before and after.
#[test]
fn a_checkpoint_leaves_a_ref_and_the_agents_git_status_untouched() {
    let env = env();
    let f = Fixture::new("ckpt-status");
    let a = f
        .trees
        .create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 1)
        .unwrap();

    // The agent's typical mess: a tracked edit, a new file, a staged file.
    std::fs::write(Path::new(&a.path).join("app.txt"), "edited\n").unwrap();
    std::fs::write(Path::new(&a.path).join("fresh.txt"), "new\n").unwrap();
    std::fs::write(Path::new(&a.path).join("staged.txt"), "staged\n").unwrap();
    git(Path::new(&a.path), &["add", "staged.txt"]);

    let before = git(Path::new(&a.path), &["status", "--porcelain=v2", "--branch"]);
    let cp = f
        .trees
        .checkpoint(&hr(&env), &a.path, "attempt-1", &a.base_sha)
        .unwrap()
        .expect("real changes must produce a checkpoint");
    let after = git(Path::new(&a.path), &["status", "--porcelain=v2", "--branch"]);

    assert_eq!(before, after, "the snapshot moved the agent's git state");
    assert_eq!(cp.n, 1);

    // The snapshot holds everything, untracked and staged alike.
    let held = git(f.repo.as_path(), &["ls-tree", "-r", "--name-only", &cp.sha]);
    for name in ["app.txt", "fresh.txt", "staged.txt"] {
        assert!(held.lines().any(|l| l == name), "{name} missing from the snapshot");
    }
    let refs = git(f.repo.as_path(), &["for-each-ref", "refs/agentdesk/checkpoints"]);
    assert!(refs.contains("refs/agentdesk/checkpoints/attempt-1/1"));
}

/// A quiet turn adds nothing: same tree, no new ref — and the numbering
/// continues where it left off when something does change.
#[test]
fn an_unchanged_worktree_produces_no_new_checkpoint() {
    let env = env();
    let f = Fixture::new("ckpt-quiet");
    let a = f
        .trees
        .create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 1)
        .unwrap();

    // Nothing has changed since base: even the first ask is a no-op.
    assert!(f
        .trees
        .checkpoint(&hr(&env), &a.path, "attempt-1", &a.base_sha)
        .unwrap()
        .is_none());

    std::fs::write(Path::new(&a.path).join("app.txt"), "round one\n").unwrap();
    let one = f
        .trees
        .checkpoint(&hr(&env), &a.path, "attempt-1", &a.base_sha)
        .unwrap()
        .unwrap();
    assert_eq!(one.n, 1);
    assert!(f
        .trees
        .checkpoint(&hr(&env), &a.path, "attempt-1", &a.base_sha)
        .unwrap()
        .is_none());

    std::fs::write(Path::new(&a.path).join("app.txt"), "round two\n").unwrap();
    let two = f
        .trees
        .checkpoint(&hr(&env), &a.path, "attempt-1", &a.base_sha)
        .unwrap()
        .unwrap();
    assert_eq!(two.n, 2, "numbering must continue, not restart");

    let list = f.trees.checkpoints(&hr(&env), &a.path, "attempt-1").unwrap();
    assert_eq!(list.iter().map(|c| c.n).collect::<Vec<_>>(), vec![1, 2]);
    // Each snapshot parents on the one before, so "what did this turn do"
    // is one diff away.
    let parent = git(f.repo.as_path(), &["rev-parse", &format!("{}^", two.sha)]);
    assert_eq!(parent, one.sha);
}

/// The end of an attempt takes its refs with it; the sweep catches what a
/// crash left behind — and only that.
#[test]
fn refs_are_cleared_at_the_end_and_orphans_are_swept() {
    let env = env();
    let f = Fixture::new("ckpt-clear");
    let a = f
        .trees
        .create(&hr(&env), &f.trees.local_root(), &f.repo_s(), "main", "card", 1)
        .unwrap();

    std::fs::write(Path::new(&a.path).join("app.txt"), "live\n").unwrap();
    f.trees
        .checkpoint(&hr(&env), &a.path, "attempt-live", &a.base_sha)
        .unwrap()
        .unwrap();
    std::fs::write(Path::new(&a.path).join("app.txt"), "dead\n").unwrap();
    f.trees
        .checkpoint(&hr(&env), &a.path, "attempt-dead", &a.base_sha)
        .unwrap()
        .unwrap();

    // The finished attempt's refs go, from the main checkout — the worktree
    // may already be gone by then.
    f.trees
        .clear_checkpoints(&hr(&env), &f.repo_s(), "attempt-dead")
        .unwrap();
    let refs = git(f.repo.as_path(), &["for-each-ref", "refs/agentdesk/checkpoints"]);
    assert!(!refs.contains("attempt-dead"));
    assert!(refs.contains("attempt-live"));

    // The sweep with only `attempt-live` open leaves it alone and reports
    // nothing to do; with nothing open it takes the leftovers.
    let live: std::collections::HashSet<String> =
        std::iter::once("attempt-live".to_string()).collect();
    assert_eq!(f.trees.sweep_checkpoints(&hr(&env), &f.repo_s(), &live).unwrap(), 0);
    let none: std::collections::HashSet<String> = Default::default();
    assert_eq!(f.trees.sweep_checkpoints(&hr(&env), &f.repo_s(), &none).unwrap(), 1);
    let refs = git(f.repo.as_path(), &["for-each-ref", "refs/agentdesk/checkpoints"]);
    assert_eq!(refs.trim(), "");
}
