//! Git worktrees, one per attempt.
//!
//! An attempt is a go at a card with one agent, and it gets its own worktree
//! and its own branch so two agents can work the same repository at the same
//! time without seeing each other's files. The base commit is recorded when
//! the worktree opens, because that — not `main` as it stands later — is what
//! the attempt's diff is against.
//!
//! Every git invocation goes through the repository's host and its login
//! environment, for the same reason sessions do: the user's git, the user's
//! git config, and later the credentials and SSH agent that `git push` and
//! `gh` need. A GUI process's own environment has none of that — and for a
//! repository inside WSL, the git that owns it is the distro's, not ours.
//!
//! Paths in here are strings in the host's own spelling, never `PathBuf`:
//! on Windows a `PathBuf` joins with backslashes, which would quietly corrupt
//! a POSIX path inside a distro.

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::PathBuf;

use crate::host::{Host, HostRef};

/// Longest slug taken from a title. Long enough to recognise the card in
/// `git branch`, short enough that the worktree path stays readable.
const MAX_SLUG: usize = 32;

/// Where a newly opened attempt lives, in host-side paths.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedWorktree {
    pub path: String,
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
fn path_hash(p: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in p.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:08x}")[..8].to_string()
}

fn git(hr: &HostRef, cwd: &str, args: &[&str]) -> Result<String> {
    let out = hr
        .run("git", args, Some(cwd))
        .with_context(|| format!("running git {}", args.join(" ")))?;
    if !out.status.success() {
        return Err(anyhow!(
            "git {} failed in {cwd}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Whether git already knows this branch. Checked before claiming a name,
/// because a branch outlives both the worktree that made it and the row that
/// recorded it: delete a card, make another with the same title, and the
/// numbering starts over onto branches that are still there.
fn branch_exists(hr: &HostRef, repo: &str, branch: &str) -> bool {
    hr.run(
        "git",
        &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")],
        Some(repo),
    )
    .map(|o| o.status.success())
    .unwrap_or(false)
}

/// The directory holding one repository's worktrees, under `root`.
fn dir_for(host: &Host, root: &str, repo: &str) -> String {
    let name = repo.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or("repo");
    host.join(root, &format!("{name}-{}", path_hash(repo)))
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

    /// This app machine's own worktree root. A non-local host keeps its
    /// worktrees in its own filesystem — see `Core::host_env`.
    pub fn local_root(&self) -> String {
        self.root.to_string_lossy().to_string()
    }

    /// Where a branch points right now.
    pub fn head_of(&self, hr: &HostRef, repo: &str, branch: &str) -> Result<String> {
        git(hr, repo, &["rev-parse", branch])
    }

    /// Refuse a card that cannot produce a working attempt, at the moment it
    /// is created rather than when someone first tries to run it. Ad-hoc
    /// sessions are not subject to any of this — they are just a directory.
    pub fn check_repo(&self, hr: &HostRef, repo: &str, base_branch: &str) -> Result<()> {
        if !hr.is_dir(repo) {
            return Err(anyhow!("{repo} is not a directory"));
        }
        let inside = git(hr, repo, &["rev-parse", "--is-inside-work-tree"])
            .map_err(|_| anyhow!("{repo} is not a git repository"))?;
        if inside.trim() != "true" {
            return Err(anyhow!("{repo} is not a git repository"));
        }
        if !branch_exists(hr, repo, base_branch) {
            return Err(anyhow!("{repo} has no branch `{base_branch}`"));
        }
        Ok(())
    }

    /// Open a worktree for an attempt: a fresh branch off `base_branch`, in a
    /// directory of its own under `root` — which lives in the same host as
    /// the repository, never on the app's side of a boundary.
    ///
    /// `start_seq` is where numbering begins; if git already has that branch
    /// or the directory is occupied, this walks forward and reports which
    /// number it actually took.
    #[allow(clippy::too_many_arguments)]
    pub fn create(
        &self,
        hr: &HostRef,
        root: &str,
        repo: &str,
        base_branch: &str,
        slug: &str,
        start_seq: i64,
    ) -> Result<OpenedWorktree> {
        self.check_repo(hr, repo, base_branch)?;

        // The base as it stands right now. Recorded rather than re-resolved
        // later, because `main` keeps moving and the attempt's diff has to
        // stay against what it actually started from.
        let base_sha = git(hr, repo, &["rev-parse", base_branch])?;

        let dir = dir_for(hr.host, root, repo);
        hr.mkdir_p(&dir)
            .with_context(|| format!("creating {dir}"))?;

        let mut seq = start_seq.max(1);
        let (path, branch) = loop {
            if seq > start_seq + 1000 {
                return Err(anyhow!("no free attempt number for `{slug}` after 1000 tries"));
            }
            let branch = format!("agentdesk/{slug}-{seq}");
            let path = hr.join(&dir, &format!("{slug}-{seq}"));
            if !branch_exists(hr, repo, &branch) && !hr.exists(&path) {
                break (path, branch);
            }
            seq += 1;
        };

        git(
            hr,
            repo,
            &["worktree", "add", "-b", &branch, &path, base_branch],
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
    pub fn remove(&self, hr: &HostRef, repo: &str, path: &str) -> Result<()> {
        if hr.exists(path) {
            git(hr, repo, &["worktree", "remove", "--force", path])
                .with_context(|| format!("removing the worktree at {path}"))?;
        }
        // Clears the administrative entry when the directory was already gone
        // — deleted by hand, or on a volume that did not come back.
        git(hr, repo, &["worktree", "prune"])?;
        Ok(())
    }

    /// Fold an attempt's branch back into the base.
    ///
    /// Every refusal here is one that would otherwise lose work quietly:
    ///
    ///   * The attempt's worktree still has uncommitted changes. Merging the
    ///     branch would produce a merge that does not contain them, and the
    ///     work would sit in a directory that is about to be removed.
    ///   * The main checkout is on some other branch, or has changes of its
    ///     own. Merging into it would rewrite what the person is in the
    ///     middle of.
    ///
    /// Said plainly and refused, rather than worked around: a merge that
    /// silently did something other than what it says is worse than one that
    /// asks you to tidy up first.
    pub fn merge_to_base(
        &self,
        hr: &HostRef,
        repo: &str,
        worktree: &str,
        branch: &str,
        base_branch: &str,
    ) -> Result<String> {
        let dirty = git(hr, worktree, &["status", "--porcelain"])?;
        if !dirty.trim().is_empty() {
            return Err(anyhow!(
                "{branch} 還有沒有 commit 的變更，合併不會包含它們。\
                 請先在 attempt 的 TUI 裡 commit，或改用「丟棄」。"
            ));
        }

        let on = git(hr, repo, &["rev-parse", "--abbrev-ref", "HEAD"])?;
        if on.trim() != base_branch {
            return Err(anyhow!(
                "這個 repo 目前在 `{}`，不是 `{base_branch}`。切過去再合併。",
                on.trim()
            ));
        }
        let repo_dirty = git(hr, repo, &["status", "--porcelain"])?;
        if !repo_dirty.trim().is_empty() {
            return Err(anyhow!(
                "`{base_branch}` 的工作目錄有未提交的變更，先收乾淨再合併。"
            ));
        }

        let ahead = git(
            hr,
            repo,
            &["rev-list", "--count", &format!("{base_branch}..{branch}")],
        )?;
        if ahead.trim() == "0" {
            return Err(anyhow!(
                "{branch} 沒有任何 `{base_branch}` 還沒有的 commit，沒有東西可以合併。"
            ));
        }

        // `--no-ff` so the attempt stays legible as one piece of work in the
        // history rather than dissolving into the base.
        git(
            hr,
            repo,
            &[
                "merge",
                "--no-ff",
                "-m",
                &format!("Merge {branch} (AgentDesk attempt)"),
                branch,
            ],
        )?;
        git(hr, repo, &["rev-parse", "HEAD"])
    }

    /// Push the attempt's branch and open a pull request for it.
    ///
    /// The push runs from the worktree, which is already on the branch. `gh`
    /// resolves inside the repository's host like everything else, because
    /// its credentials live in that environment, not in ours.
    #[allow(clippy::too_many_arguments)]
    pub fn push_and_open_pr(
        &self,
        hr: &HostRef,
        worktree: &str,
        branch: &str,
        base_branch: &str,
        title: &str,
        body: &str,
    ) -> Result<String> {
        let dirty = git(hr, worktree, &["status", "--porcelain"])?;
        if !dirty.trim().is_empty() {
            return Err(anyhow!(
                "{branch} 還有沒有 commit 的變更，推上去不會包含它們。請先 commit。"
            ));
        }

        git(hr, worktree, &["push", "--set-upstream", "origin", branch])?;

        let out = hr
            .run(
                "gh",
                &[
                    "pr", "create", "--base", base_branch, "--head", branch, "--title", title,
                    "--body", body,
                ],
                Some(worktree),
            )
            .map_err(|_| anyhow!("`gh` 不在這個環境的 PATH 上，無法開 PR"))?;
        if !out.status.success() {
            return Err(anyhow!(
                "gh pr create 失敗：{}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        // gh prints the URL of the pull request it made.
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// What this attempt has changed since it started.
    ///
    /// Two calls, because `git diff` only knows about tracked files and an
    /// agent's most common act is creating one. A diff that silently omits
    /// every new file cannot answer "what did this attempt do", which is the
    /// only reason the diff exists.
    pub fn diff(&self, hr: &HostRef, worktree: &str, base_sha: &str) -> Result<String> {
        let tracked = git(hr, worktree, &["diff", base_sha])?;
        let untracked = git(
            hr,
            worktree,
            &["ls-files", "--others", "--exclude-standard"],
        )?;

        let mut out = tracked;
        for file in untracked.lines().filter(|l| !l.trim().is_empty()) {
            // `--no-index` against /dev/null renders a new file as the patch
            // that would create it, so it reads like the rest of the diff.
            // It exits 1 when there is a difference, which there always is.
            let rendered = hr.run(
                "git",
                &["diff", "--no-index", "--", "/dev/null", file],
                Some(worktree),
            );
            if let Ok(o) = rendered {
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(&String::from_utf8_lossy(&o.stdout));
            }
        }
        Ok(out)
    }

    /// The repository's branches, most recently committed first — the
    /// order a person thinks in ("the one I touched yesterday").
    /// Remote-tracking branches count too, stripped of their remote and
    /// deduped, so a base that only exists as `origin/x` is still offered.
    pub fn branches(&self, hr: &HostRef, repo: &str) -> Result<Vec<String>> {
        let out = git(
            hr,
            repo,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname)",
                "refs/heads",
                "refs/remotes",
            ],
        )?;
        Ok(parse_branches(&out))
    }

    /// The attempt's footprint at a glance, cheap enough for every card on
    /// the board to ask on a timer: `--numstat` counts rather than the
    /// rendered diff, plus where the branch stands against its base.
    ///
    /// Untracked files go through `--no-index` per file, the same route
    /// `diff` takes — never `add -N`, which would mutate the agent's own
    /// index behind its back to save ourselves a few invocations.
    ///
    /// Ahead and behind are measured against the base *branch* as it is
    /// now, not the recorded base commit: the diff answers "what did this
    /// attempt do", but ahead/behind answers "will the merge go", and the
    /// merge goes against the branch that kept moving.
    pub fn stat(
        &self,
        hr: &HostRef,
        worktree: &str,
        base_sha: &str,
        base_branch: &str,
    ) -> Result<DiffStat> {
        let mut stat = DiffStat::default();

        let tracked = git(hr, worktree, &["diff", "--numstat", base_sha])?;
        for line in tracked.lines() {
            stat.count(line);
        }

        let untracked = git(
            hr,
            worktree,
            &["ls-files", "--others", "--exclude-standard"],
        )?;
        for file in untracked.lines().filter(|l| !l.trim().is_empty()) {
            let counted = hr.run(
                "git",
                &["diff", "--no-index", "--numstat", "--", "/dev/null", file],
                Some(worktree),
            );
            if let Ok(o) = counted {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    stat.count(line);
                }
            }
        }

        // `left...right` with --left-right --count prints "behind\tahead"
        // from the branch's point of view.
        let counts = git(
            hr,
            worktree,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{base_branch}...HEAD"),
            ],
        )?;
        let mut parts = counts.split_whitespace();
        stat.behind = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);
        stat.ahead = parts.next().and_then(|n| n.parse().ok()).unwrap_or(0);

        // Whether anything is still uncommitted — the exact check the merge
        // will make, run ahead of it, so the refusal can become a suggestion
        // before the click instead of an error after it.
        let dirty = git(hr, worktree, &["status", "--porcelain"])?;
        stat.dirty = !dirty.trim().is_empty();

        Ok(stat)
    }

    /* -------------------------- checkpoints -------------------------- */

    /// The checkpoints an attempt has, oldest first. Read from the refs
    /// themselves, so a restart forgets nothing and the numbering never
    /// restarts into a collision.
    pub fn checkpoints(&self, hr: &HostRef, git_cwd: &str, attempt_id: &str) -> Result<Vec<Checkpoint>> {
        let raw = git(
            hr,
            git_cwd,
            &[
                "for-each-ref",
                "--format=%(refname)\t%(objectname)\t%(creatordate:unix)",
                &checkpoint_prefix(attempt_id),
            ],
        )?;
        let mut out: Vec<Checkpoint> = Vec::new();
        for line in raw.lines() {
            let mut cols = line.split('\t');
            let (Some(refname), Some(sha), Some(at)) = (cols.next(), cols.next(), cols.next())
            else {
                continue;
            };
            let Some(n) = refname.rsplit('/').next().and_then(|s| s.parse::<u64>().ok()) else {
                continue;
            };
            out.push(Checkpoint {
                n,
                sha: sha.to_string(),
                at: at.trim().parse().unwrap_or(0),
            });
        }
        // for-each-ref sorts refnames lexically, where 10 comes before 2.
        out.sort_by_key(|c| c.n);
        Ok(out)
    }

    /// Snapshot the worktree — tracked and untracked alike — touching nothing
    /// the agent sees. A temporary index (`GIT_INDEX_FILE`) takes the `add
    /// -A`, `write-tree` turns it into a tree, `commit-tree` parents it on
    /// the previous checkpoint (or the attempt's base), and a ref under
    /// `refs/agentdesk/checkpoints/<attempt>/<n>` keeps it alive. Worktree,
    /// index, branch, reflog: all exactly as the agent left them — the same
    /// discipline that keeps `stat` away from `add -N`.
    ///
    /// The temp index persists beside the worktree's own git dir, so the
    /// second snapshot onward pays a stat walk, not a re-hash of every file.
    /// A turn that changed nothing produces no ref and returns `None`.
    pub fn checkpoint(
        &self,
        hr: &HostRef,
        worktree: &str,
        attempt_id: &str,
        base_sha: &str,
    ) -> Result<Option<Checkpoint>> {
        let gitdir = git(hr, worktree, &["rev-parse", "--absolute-git-dir"])?;
        let index = format!("{}/agentdesk-checkpoint.index", gitdir.trim_end_matches('/'));
        let snap_env = [("GIT_INDEX_FILE".to_string(), index)];
        hr.run_ok_with_env("git", &["add", "-A"], Some(worktree), &snap_env)?;
        let tree = hr.run_ok_with_env("git", &["write-tree"], Some(worktree), &snap_env)?;

        let existing = self.checkpoints(hr, worktree, attempt_id)?;
        let prev = existing.last();
        let parent = prev.map(|c| c.sha.as_str()).unwrap_or(base_sha);
        let prev_tree = git(hr, worktree, &["rev-parse", &format!("{parent}^{{tree}}")])?;
        if tree == prev_tree {
            return Ok(None);
        }

        let n = prev.map(|c| c.n + 1).unwrap_or(1);
        // Its own identity, so a repo (or host) with no user.name configured
        // can still snapshot — and no checkpoint ever wears the user's name.
        let id_env = [
            ("GIT_AUTHOR_NAME".to_string(), "AgentDesk".to_string()),
            ("GIT_AUTHOR_EMAIL".to_string(), "checkpoint@agentdesk.local".to_string()),
            ("GIT_COMMITTER_NAME".to_string(), "AgentDesk".to_string()),
            ("GIT_COMMITTER_EMAIL".to_string(), "checkpoint@agentdesk.local".to_string()),
        ];
        let sha = hr.run_ok_with_env(
            "git",
            &["commit-tree", &tree, "-p", parent, "-m", &format!("agentdesk checkpoint {n}")],
            Some(worktree),
            &id_env,
        )?;
        git(
            hr,
            worktree,
            &["update-ref", &format!("{}/{n}", checkpoint_prefix(attempt_id)), &sha],
        )?;
        let at = git(hr, worktree, &["show", "-s", "--format=%ct", &sha])?
            .trim()
            .parse()
            .unwrap_or(0);
        Ok(Some(Checkpoint { n, sha, at }))
    }

    /// Put the worktree's files back to a snapshot — code only. Content is
    /// restored from the snapshot's tree, and files that exist now but not
    /// in it are deleted. The index, the branch, the reflog and the agent's
    /// conversation are never touched: a restore changes exactly what a
    /// person editing files by hand could change, nothing else.
    pub fn restore_checkpoint(&self, hr: &HostRef, worktree: &str, sha: &str) -> Result<()> {
        // What the snapshot holds, against what the worktree holds now —
        // tracked or untracked. Ignored files are neither snapshotted nor
        // deleted: they were never part of the work. NUL separators, so a
        // hostile filename cannot split into two.
        let held = git(hr, worktree, &["ls-tree", "-r", "--name-only", "-z", sha])?;
        let now = git(
            hr,
            worktree,
            &["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        )?;
        let held_set: std::collections::HashSet<&str> =
            held.split('\0').filter(|s| !s.is_empty()).collect();
        for file in now.split('\0').filter(|s| !s.is_empty()) {
            if !held_set.contains(file) {
                hr.remove_file(&hr.join(worktree, file))?;
            }
        }
        // Everything the snapshot does hold comes back as it was. Worktree
        // only — `--staged` is exactly the flag this must never grow.
        git(hr, worktree, &["restore", "--source", sha, "--worktree", "--", ":/"])?;
        Ok(())
    }

    /// Delete every checkpoint ref an attempt holds. Run at the attempt's
    /// end: from then on the frozen diff is the one record, and the refs
    /// would otherwise pin every snapshot's objects forever. `git_cwd` is
    /// any directory of the repository — the refs live in the shared git
    /// dir, so the main checkout works after the worktree is gone.
    pub fn clear_checkpoints(&self, hr: &HostRef, git_cwd: &str, attempt_id: &str) -> Result<()> {
        let raw = git(
            hr,
            git_cwd,
            &["for-each-ref", "--format=%(refname)", &checkpoint_prefix(attempt_id)],
        )?;
        for r in raw.lines().map(str::trim).filter(|r| !r.is_empty()) {
            git(hr, git_cwd, &["update-ref", "-d", r])?;
        }
        Ok(())
    }

    /// Drop checkpoint refs whose attempt is no longer open — the crash
    /// leftovers. Run once per repository at startup; returns how many refs
    /// went.
    pub fn sweep_checkpoints(
        &self,
        hr: &HostRef,
        repo: &str,
        live_attempts: &std::collections::HashSet<String>,
    ) -> Result<usize> {
        let raw = git(
            hr,
            repo,
            &["for-each-ref", "--format=%(refname)", "refs/agentdesk/checkpoints"],
        )?;
        let mut swept = 0;
        for r in raw.lines().map(str::trim).filter(|r| !r.is_empty()) {
            let attempt = r
                .strip_prefix("refs/agentdesk/checkpoints/")
                .and_then(|rest| rest.split('/').next());
            if let Some(id) = attempt {
                if !live_attempts.contains(id) {
                    git(hr, repo, &["update-ref", "-d", r])?;
                    swept += 1;
                }
            }
        }
        Ok(swept)
    }
}

/// One numbered snapshot of an attempt's worktree, held by a private ref.
#[derive(Debug, Clone, Serialize)]
pub struct Checkpoint {
    /// Ordinal within the attempt, starting at 1 — `base_sha` is the free
    /// zeroth.
    pub n: u64,
    /// The snapshot commit. Diffable and restorable like any tree-ish.
    pub sha: String,
    /// Unix seconds, from the snapshot commit's own clock.
    pub at: i64,
}

fn checkpoint_prefix(attempt_id: &str) -> String {
    format!("refs/agentdesk/checkpoints/{attempt_id}")
}

/// Full refnames into offerable branch names: `refs/heads/x` and
/// `refs/remotes/<remote>/x` both become `x`, first (most recent) sighting
/// wins, remote HEAD pointers are noise and dropped. Full refnames rather
/// than shorthand, because a local `feature/x` and a remote `origin/x` are
/// indistinguishable once shortened. Capped: past fifty a picker is a
/// search box, and typing already filters.
fn parse_branches(raw: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in raw.lines() {
        let name = if let Some(rest) = line.trim().strip_prefix("refs/heads/") {
            rest
        } else if let Some(rest) = line.trim().strip_prefix("refs/remotes/") {
            match rest.split_once('/') {
                Some((_, branch)) => branch,
                None => continue,
            }
        } else {
            continue;
        };
        if name.is_empty() || name == "HEAD" || out.iter().any(|b| b == name) {
            continue;
        }
        out.push(name.to_string());
        if out.len() >= 50 {
            break;
        }
    }
    out
}

/// What `stat` measures. Serialized as-is to the UI.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct DiffStat {
    /// Files touched, counting untracked ones — an agent's commonest act.
    pub files: i64,
    pub adds: i64,
    pub dels: i64,
    /// Commits the branch has that the base does not.
    pub ahead: i64,
    /// Commits the base has grown since — the merge refusal not yet hit.
    pub behind: i64,
    /// Uncommitted work in the worktree — the other refusal not yet hit.
    pub dirty: bool,
}

impl DiffStat {
    /// One `--numstat` line: `adds\tdels\tpath`. A binary file prints `-`
    /// for both counts; it is still a touched file, just not counted lines.
    fn count(&mut self, line: &str) {
        let mut cols = line.split('\t');
        let (Some(a), Some(d)) = (cols.next(), cols.next()) else {
            return;
        };
        if cols.next().is_none() {
            return;
        }
        self.files += 1;
        self.adds += a.parse::<i64>().unwrap_or(0);
        self.dels += d.parse::<i64>().unwrap_or(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /* -------------------------- branches ---------------------------- */

    #[test]
    fn refnames_become_offerable_branches_in_order() {
        let raw = "refs/heads/fix-login\nrefs/remotes/origin/main\nrefs/heads/feature/x\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/fix-login\nrefs/remotes/upstream/main\n";
        assert_eq!(
            parse_branches(raw),
            vec!["fix-login", "main", "feature/x"]
        );
    }

    /// A local `feature/x` must survive shortening — the reason the parse
    /// works on full refnames rather than `refname:short`.
    #[test]
    fn a_local_branch_with_a_slash_is_not_mistaken_for_a_remote() {
        assert_eq!(parse_branches("refs/heads/feature/login\n"), vec!["feature/login"]);
    }

    #[test]
    fn the_list_is_capped_at_fifty() {
        let raw: String = (0..80).map(|i| format!("refs/heads/b{i}\n")).collect();
        assert_eq!(parse_branches(&raw).len(), 50);
    }

    /* -------------------------- diffstat ---------------------------- */

    #[test]
    fn numstat_lines_are_counted() {
        let mut s = DiffStat::default();
        s.count("12\t3\tsrc/app.ts");
        s.count("0\t7\tREADME.md");
        // A binary file prints `-` for both counts; it is still a file
        // the attempt touched, just not countable lines.
        s.count("-\t-\tlogo.png");
        assert_eq!(
            s,
            DiffStat { files: 3, adds: 12, dels: 10, ..DiffStat::default() }
        );
    }

    /// Whatever is not a numstat row — blank lines, stray warnings on
    /// stdout — must not count as a touched file.
    #[test]
    fn noise_is_not_a_file() {
        let mut s = DiffStat::default();
        s.count("");
        s.count("warning: exhaustive rename detection was skipped");
        s.count("12\t3");
        assert_eq!(s, DiffStat::default());
    }

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
        let a = dir_for(&Host::Local, "/tmp/root", "/Users/x/work/api");
        let b = dir_for(&Host::Local, "/tmp/root", "/Users/x/side/api");
        assert_ne!(a, b);
        assert!(a.contains("api-"));
        assert!(b.contains("api-"));
    }

    #[test]
    fn the_same_repository_always_gets_the_same_directory() {
        assert_eq!(
            dir_for(&Host::Local, "/tmp/root", "/Users/x/work/api"),
            dir_for(&Host::Local, "/tmp/root", "/Users/x/work/api")
        );
    }

    /// A distro-side layout is POSIX regardless of what the app runs on.
    #[test]
    fn a_wsl_repositorys_worktrees_land_under_its_own_root() {
        let host = Host::Wsl {
            distro: "Ubuntu".into(),
        };
        let dir = dir_for(&host, "/home/me/.agentdesk/worktrees", "/home/me/code/api");
        assert!(
            dir.starts_with("/home/me/.agentdesk/worktrees/api-"),
            "{dir}"
        );
        assert!(!dir.contains('\\'));
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
