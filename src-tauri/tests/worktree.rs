//! Worktree isolation, against real git.
//!
//! The properties here are the ones that decide whether running two agents on
//! one repository is real or only looks real: that the two never see each
//! other's files, that each diffs against the commit it actually started
//! from, and that the disk is given back afterwards.
//!
//!     cargo test --test worktree -- --nocapture

use std::path::{Path, PathBuf};

#[path = "../src/shell_env.rs"]
mod shell_env;
#[path = "../src/worktree.rs"]
mod worktree;

use crate::shell_env::ShellEnv;
use crate::worktree::{slug, Worktrees};

fn env() -> ShellEnv {
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(shell_env::resolve())
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
        .create(&env, &f.repo, "main", "login", 1)
        .expect("first attempt");
    let b = f
        .trees
        .create(&env, &f.repo, "main", "login", 2)
        .expect("second attempt");

    assert_ne!(a.path, b.path);
    assert_eq!(a.branch, "agentdesk/login-1");
    assert_eq!(b.branch, "agentdesk/login-2");

    // Each agent writes in its own tree.
    std::fs::write(a.path.join("app.txt"), "from attempt one\n").unwrap();
    std::fs::write(a.path.join("only-in-a.txt"), "a\n").unwrap();
    std::fs::write(b.path.join("app.txt"), "from attempt two\n").unwrap();

    assert_eq!(
        std::fs::read_to_string(b.path.join("app.txt")).unwrap(),
        "from attempt two\n",
        "one attempt's edit reached the other's tree"
    );
    assert!(
        !b.path.join("only-in-a.txt").exists(),
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
    let a = f.trees.create(&env, &f.repo, "main", "card", 1).unwrap();
    assert_eq!(a.base_sha, first_base);

    f.commit_on_main("two\n");
    let second_base = f.head();
    assert_ne!(first_base, second_base);

    let b = f.trees.create(&env, &f.repo, "main", "card", 2).unwrap();
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

    let a = f.trees.create(&env, &f.repo, "main", "card", 1).unwrap();
    std::fs::write(a.path.join("app.txt"), "uncommitted\n").unwrap();
    std::fs::write(a.path.join("scratch.txt"), "junk\n").unwrap();
    assert!(a.path.exists());

    f.trees.remove(&env, &f.repo, &a.path).expect("remove");

    assert!(!a.path.exists(), "the worktree directory is still on disk");
    let listed = git(&f.repo, &["worktree", "list"]);
    assert!(
        !listed.contains(&a.path.to_string_lossy().to_string()),
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

    let a = f.trees.create(&env, &f.repo, "main", "card", 1).unwrap();
    // Deleted by hand, or an external volume that did not come back.
    std::fs::remove_dir_all(&a.path).unwrap();

    f.trees
        .remove(&env, &f.repo, &a.path)
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
        .create(&env, &f.repo, "main", "card", 1)
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
        .create(&env, &f.repo, "main", &s, 1)
        .expect("git rejected the branch name");

    assert_eq!(a.branch, "agentdesk/task-9f8e7d6c-1");
    assert!(a.path.exists());
    assert_eq!(
        git(&a.path, &["rev-parse", "--abbrev-ref", "HEAD"]),
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

    let a = f.trees.create(&env, &f.repo, "main", "card", 1).unwrap();
    std::fs::write(a.path.join("app.txt"), "edited by the agent\n").unwrap();
    std::fs::write(a.path.join("brand_new.rs"), "fn main() {}\n").unwrap();

    let diff = f.trees.diff(&env, &a.path, &a.base_sha).expect("diff");

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

    let a = f.trees.create(&env, &f.repo, "main", "card", 1).unwrap();
    std::fs::write(a.path.join("done.txt"), "committed work\n").unwrap();
    git(&a.path, &["add", "-A"]);
    git(&a.path, &["commit", "-qm", "agent's commit"]);
    std::fs::write(a.path.join("app.txt"), "still in progress\n").unwrap();

    let diff = f.trees.diff(&env, &a.path, &a.base_sha).unwrap();
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
        .check_repo(&env, &dir, "main")
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
        .check_repo(&env, &f.repo, "develop")
        .expect_err("a missing base branch must be caught when the card is made");
    assert!(
        err.to_string().contains("no branch `develop`"),
        "unhelpful error: {err}"
    );
    // And nothing was created on the way to finding out.
    assert!(!f.trees.dir_for(&f.repo).exists());
}
