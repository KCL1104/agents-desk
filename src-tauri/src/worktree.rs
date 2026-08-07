//! Git worktrees, one per attempt.
//!
//! An attempt is a go at a card with one agent, and it gets its own worktree
//! and its own branch so two agents can work the same repository at the same
//! time without seeing each other's files. The base commit is recorded when
//! the worktree opens, because that — not `main` as it stands later — is what
//! the attempt's diff is against.
//!
//! Every git invocation goes through the login-shell environment for the same
//! reason sessions do: the user's git, the user's git config, and later the
//! credentials and SSH agent that `git push` and `gh` need. A GUI process's
//! own environment has none of that.

use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};

use crate::shell_env::ShellEnv;

/// Longest slug taken from a title. Long enough to recognise the card in
/// `git branch`, short enough that the worktree path stays readable.
const MAX_SLUG: usize = 32;

/// Where a newly opened attempt lives.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedWorktree {
    pub path: PathBuf,
    pub branch: String,
    pub base_sha: String,
    /// Which attempt number this turned out to be. May be higher than asked
    /// for, if git already had branches in the way.
    pub seq: i64,
}

pub struct Worktrees {
    root: PathBuf,
}

/// Turn a card title into something that can be a branch name and a directory.
///
/// Titles here are commonly Chinese, and a title with no ASCII in it at all
/// slugifies to nothing — `agentdesk/-1` is not a valid branch and `-1` is a
/// directory name that reads as a flag to half the tools that would touch it.
/// So an empty result falls back to the task id, which is always usable and
/// still identifies the card.
pub fn slug(title: &str, task_id: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true; // leading dashes are never wanted
    for ch in title.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash && out.len() < MAX_SLUG {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= MAX_SLUG {
            break;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        // Short prefix of the id: enough to tell two cards apart, short
        // enough to stay readable in `git branch`.
        let short: String = task_id.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
        return format!("task-{short}");
    }
    out
}

/// FNV-1a. Two checkouts of different repositories often share a folder name
/// (`api`, `web`), so the directory that holds a repository's worktrees is
/// keyed by its full path, not just its last component.
fn path_hash(p: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in p.to_string_lossy().as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:08x}")[..8].to_string()
}

fn git(env: &ShellEnv, repo: &Path, args: &[&str]) -> Result<String> {
    let exe = env
        .which("git")
        .ok_or_else(|| anyhow!("`git` not found on the login-shell PATH"))?;
    let out = std::process::Command::new(&exe)
        .args(args)
        .current_dir(repo)
        .envs(&env.vars)
        .output()
        .with_context(|| format!("running git {}", args.join(" ")))?;
    if !out.status.success() {
        return Err(anyhow!(
            "git {} failed in {}: {}",
            args.join(" "),
            repo.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Whether git already knows this branch. Checked before claiming a name,
/// because a branch outlives both the worktree that made it and the row that
/// recorded it: delete a card, make another with the same title, and the
/// numbering starts over onto branches that are still there.
fn branch_exists(env: &ShellEnv, repo: &Path, branch: &str) -> bool {
    let exe = match env.which("git") {
        Some(e) => e,
        None => return false,
    };
    std::process::Command::new(exe)
        .args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")])
        .current_dir(repo)
        .envs(&env.vars)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

impl Worktrees {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// `~/.agentdesk/worktrees`.
    ///
    /// Not beside the repository, which is where this obviously belongs until
    /// you notice that a repository's parent directory is very often itself a
    /// repository — an umbrella workspace holding several checkouts. Putting
    /// worktrees there nests a repository inside another one, and every tool
    /// that walks upward looking for `.git` starts answering differently.
    ///
    /// Not in the application support directory either: these are working
    /// trees a person will want to `cd` into, open in an editor, and run
    /// builds from. A path they can type is worth more than tidiness.
    pub fn default_root() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join(".agentdesk")
            .join("worktrees")
    }

    /// The directory holding one repository's worktrees.
    pub fn dir_for(&self, repo: &Path) -> PathBuf {
        let name = repo
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "repo".to_string());
        self.root.join(format!("{name}-{}", path_hash(repo)))
    }

    /// Where a branch points right now.
    pub fn head_of(&self, env: &ShellEnv, repo: &Path, branch: &str) -> Result<String> {
        git(env, repo, &["rev-parse", branch])
    }

    /// Refuse a card that cannot produce a working attempt, at the moment it
    /// is created rather than when someone first tries to run it. Ad-hoc
    /// sessions are not subject to any of this — they are just a directory.
    pub fn check_repo(&self, env: &ShellEnv, repo: &Path, base_branch: &str) -> Result<()> {
        if !repo.is_dir() {
            return Err(anyhow!("{} is not a directory", repo.display()));
        }
        let inside = git(env, repo, &["rev-parse", "--is-inside-work-tree"])
            .map_err(|_| anyhow!("{} is not a git repository", repo.display()))?;
        if inside.trim() != "true" {
            return Err(anyhow!("{} is not a git repository", repo.display()));
        }
        if !branch_exists(env, repo, base_branch) {
            return Err(anyhow!(
                "{} has no branch `{base_branch}`",
                repo.display()
            ));
        }
        Ok(())
    }

    /// Open a worktree for an attempt: a fresh branch off `base_branch`, in a
    /// directory of its own.
    ///
    /// `start_seq` is where numbering begins; if git already has that branch
    /// or the directory is occupied, this walks forward and reports which
    /// number it actually took.
    pub fn create(
        &self,
        env: &ShellEnv,
        repo: &Path,
        base_branch: &str,
        slug: &str,
        start_seq: i64,
    ) -> Result<OpenedWorktree> {
        self.check_repo(env, repo, base_branch)?;

        // The base as it stands right now. Recorded rather than re-resolved
        // later, because `main` keeps moving and the attempt's diff has to
        // stay against what it actually started from.
        let base_sha = git(env, repo, &["rev-parse", base_branch])?;

        let dir = self.dir_for(repo);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("creating {}", dir.display()))?;

        let mut seq = start_seq.max(1);
        let (path, branch) = loop {
            if seq > start_seq + 1000 {
                return Err(anyhow!("no free attempt number for `{slug}` after 1000 tries"));
            }
            let branch = format!("agentdesk/{slug}-{seq}");
            let path = dir.join(format!("{slug}-{seq}"));
            if !branch_exists(env, repo, &branch) && !path.exists() {
                break (path, branch);
            }
            seq += 1;
        };

        git(
            env,
            repo,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &path.to_string_lossy(),
                base_branch,
            ],
        )
        .with_context(|| format!("opening a worktree for `{branch}`"))?;

        Ok(OpenedWorktree {
            path,
            branch,
            base_sha,
            seq,
        })
    }

    /// Give the worktree back.
    ///
    /// The branch is deliberately left alone: it is what a merged attempt was
    /// merged from and what a superseded one can still be looked at through.
    /// Only the working tree goes.
    ///
    /// `--force` because an attempt that is being discarded is exactly the one
    /// with uncommitted work in it, and refusing to clean up in that case
    /// would leave the disk growing forever, which is the failure this step
    /// exists to prevent. The diff is frozen into the attempt row first, so
    /// what is being dropped has already been recorded.
    pub fn remove(&self, env: &ShellEnv, repo: &Path, path: &Path) -> Result<()> {
        if path.exists() {
            git(env, repo, &["worktree", "remove", "--force", &path.to_string_lossy()])
                .with_context(|| format!("removing the worktree at {}", path.display()))?;
        }
        // Clears the administrative entry when the directory was already gone
        // — deleted by hand, or on a volume that did not come back.
        git(env, repo, &["worktree", "prune"])?;
        Ok(())
    }

    /// What this attempt has changed since it started.
    ///
    /// Two calls, because `git diff` only knows about tracked files and an
    /// agent's most common act is creating one. A diff that silently omits
    /// every new file cannot answer "what did this attempt do", which is the
    /// only reason the diff exists.
    pub fn diff(&self, env: &ShellEnv, worktree: &Path, base_sha: &str) -> Result<String> {
        let tracked = git(env, worktree, &["diff", base_sha])?;
        let untracked = git(
            env,
            worktree,
            &["ls-files", "--others", "--exclude-standard"],
        )?;

        let mut out = tracked;
        for file in untracked.lines().filter(|l| !l.trim().is_empty()) {
            // `--no-index` against /dev/null renders a new file as the patch
            // that would create it, so it reads like the rest of the diff.
            // It exits 1 when there is a difference, which there always is.
            let exe = env
                .which("git")
                .ok_or_else(|| anyhow!("`git` not found on the login-shell PATH"))?;
            let rendered = std::process::Command::new(exe)
                .args(["diff", "--no-index", "--", "/dev/null", file])
                .current_dir(worktree)
                .envs(&env.vars)
                .output();
            if let Ok(o) = rendered {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&String::from_utf8_lossy(&o.stdout));
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* --------------------------- slugs ----------------------------- */

    #[test]
    fn a_title_becomes_something_git_will_accept() {
        assert_eq!(slug("Fix the login bug", "abc123"), "fix-the-login-bug");
        assert_eq!(slug("Add /api/v2 endpoint", "abc123"), "add-api-v2-endpoint");
    }

    /// Titles here are usually Chinese. A mixed one keeps whatever ASCII it
    /// has, which is normally the part a person would grep for anyway.
    #[test]
    fn a_mixed_title_keeps_its_ascii() {
        assert_eq!(slug("修好登入 bug", "abc123"), "bug");
    }

    /// The one that would produce `agentdesk/-1` and a directory called `-1`.
    #[test]
    fn a_title_with_no_ascii_falls_back_to_the_task_id() {
        assert_eq!(slug("修好登入頁面", "9f8e7d6c-1111"), "task-9f8e7d6c");
        assert_eq!(slug("！！！", "abcdef12"), "task-abcdef12");
        assert_eq!(slug("", "abcdef12"), "task-abcdef12");
    }

    /// Leading and trailing punctuation must not survive as dashes: git
    /// rejects a branch component that starts with one, and a trailing dash
    /// makes `<slug>-<n>` read as `--`.
    #[test]
    fn punctuation_never_becomes_a_leading_or_trailing_dash() {
        for title in ["  spaces  ", "--dashes--", "...dots...", "(parens)"] {
            let s = slug(title, "abc123");
            assert!(!s.starts_with('-'), "{title:?} produced {s:?}");
            assert!(!s.ends_with('-'), "{title:?} produced {s:?}");
            assert!(!s.contains("--"), "{title:?} produced {s:?}");
        }
    }

    #[test]
    fn a_long_title_is_cut_to_a_readable_length() {
        let s = slug(&"word ".repeat(50), "abc123");
        assert!(s.len() <= MAX_SLUG, "{s:?} is {} chars", s.len());
        assert!(!s.ends_with('-'));
    }

    /* --------------------------- layout ---------------------------- */

    /// Two repositories can easily share a folder name. If their worktrees
    /// shared a directory, attempt `api-1` of one would collide with `api-1`
    /// of the other.
    #[test]
    fn repositories_with_the_same_name_do_not_share_a_directory() {
        let w = Worktrees::new(PathBuf::from("/tmp/root"));
        let a = w.dir_for(Path::new("/Users/x/work/api"));
        let b = w.dir_for(Path::new("/Users/x/side/api"));
        assert_ne!(a, b);
        assert!(a.to_string_lossy().contains("api-"));
        assert!(b.to_string_lossy().contains("api-"));
    }

    #[test]
    fn the_same_repository_always_gets_the_same_directory() {
        let w = Worktrees::new(PathBuf::from("/tmp/root"));
        assert_eq!(
            w.dir_for(Path::new("/Users/x/work/api")),
            w.dir_for(Path::new("/Users/x/work/api"))
        );
    }

    /// Worktrees must not land inside a repository, because a repository's
    /// parent is so often another repository.
    #[test]
    fn the_default_root_is_not_beside_the_repository() {
        let root = Worktrees::default_root();
        assert!(root.ends_with("worktrees"));
        assert!(root.to_string_lossy().contains(".agentdesk"));
    }
}
