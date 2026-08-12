//! The first message an attempt sends.
//!
//! The agent already has everything it can discover for itself: `CLAUDE.md`,
//! skills, and MCP servers all load natively from the worktree, so repeating
//! any of that here would only crowd out the part that matters. What it
//! cannot discover is the situation Marol has just put it in — that this
//! directory is ground opened for one card, which branch it is on, and that
//! the branch is what the diff and the merge will read. That, and the
//! person's actual request, is all this template carries.
//!
//! When the card spans several repositories there is one more thing it cannot
//! discover, and it is the load-bearing one: that the directory it woke up in
//! is not a checkout but a workspace, and which of the folders below it are
//! the repositories it is allowed to change.
//!
//! It is written to disk on first run and never overwritten, so editing it is
//! a supported thing to do rather than a change that gets reverted on upgrade.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Written in Chinese to match the prompts these cards carry. An agent
/// answers in the language it was addressed in, and a bilingual first message
/// makes it drift mid-session.
pub const DEFAULT_TEMPLATE: &str = r#"[Marol 任務] {title}

{repos}
完成時請把變更 commit 在這些分支上 —— Marol 用它們來做 diff 檢視與合併回 base。

---

{prompt}
"#;

/// One checkout, as the opening message names it.
pub struct TreeVar<'a> {
    /// Its folder inside the workspace; empty when the session's own
    /// directory *is* the checkout.
    pub dir: &'a str,
    pub repo: &'a str,
    pub base_branch: &'a str,
    pub base_sha: &'a str,
}

pub struct Vars<'a> {
    pub title: &'a str,
    pub branch: &'a str,
    /// The first checkout's base — what `{base_branch}` has always meant.
    pub base_branch: &'a str,
    /// The first checkout's base commit, likewise.
    pub base_sha: &'a str,
    /// Every checkout this attempt opened, first one first. Never empty.
    pub trees: &'a [TreeVar<'a>],
    pub prompt: &'a str,
}

/// The paragraph that says what ground the agent is standing on.
///
/// Two shapes, because the two situations are genuinely different and a
/// sentence that covered both would describe neither. One repository is the
/// wording this app has always sent. Several is a workspace, and then the
/// folders have to be named — a diff path reads `web/api.ts`, and the agent
/// has to know that `web/` is a checkout it may change rather than a
/// directory it happened to be shown.
pub fn repos_block(vars: &Vars) -> String {
    let short = |sha: &str| -> String { sha.chars().take(8).collect() };
    if vars.trees.len() <= 1 {
        let t = vars.trees.first();
        let base_branch = t.map(|t| t.base_branch).unwrap_or(vars.base_branch);
        let base_sha = t.map(|t| t.base_sha).unwrap_or(vars.base_sha);
        return format!(
            "你在一個專為這張卡開的 git worktree：分支 {}，從 {base_branch} @ {} 開出。\n\
             這個 worktree 只屬於這張卡，不要切換分支，也不要動 {base_branch}。",
            vars.branch,
            short(base_sha),
        );
    }
    let mut out = format!(
        "你在一個專為這張卡開的工作區。底下每個資料夾各是一個 repo 的 git worktree，\
         全部都在同一個分支 {}：\n",
        vars.branch
    );
    for t in vars.trees {
        out.push_str(&format!(
            "- {}/ ← {}，從 {} @ {} 開出\n",
            t.dir,
            t.repo,
            t.base_branch,
            short(t.base_sha),
        ));
    }
    out.push_str(
        "這些 worktree 都只屬於這張卡，不要切換分支，也不要動它們的 base。\n\
         工作區本身不是 repo：要改哪個 repo，就進它自己的資料夾。",
    );
    out
}

/// How a given CLI is told what to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Hand the rendered prompt over as the positional argument.
    ///
    /// Measured for Claude Code, because none of it is documented: the
    /// prompt keeps the interactive TUI (`-p` is what makes it
    /// non-interactive), a multi-line string arrives as **one** message
    /// rather than one per line, and it survives the trust prompt a new
    /// worktree always opens on. Codex takes the same shape — an optional
    /// `PROMPT` positional that starts the interactive session with that
    /// message — and the parity workflow holds its `--help` to it.
    Positional,
    /// We do not know this CLI's conventions, so we do not guess. The prompt
    /// is built and shown for the person to paste in themselves.
    ///
    /// Guessing wrong is worse than not trying: the argument that means
    /// "here is your prompt" in one CLI means "print this and exit" in
    /// another, and the person would be left looking at a session that did
    /// nothing for reasons the UI never mentioned.
    Manual,
}

/// A CLI in the conventions table takes its prompt on the command line; one
/// that is not in it is not guessed at. There is no third case on purpose —
/// "measured" and "we know how to talk to it" are the same statement, and a
/// CLI that made them different would be one the table is wrong about.
pub fn delivery_for(agent: &str) -> Delivery {
    match crate::agent::Cli::of(agent) {
        Some(_) => Delivery::Positional,
        None => Delivery::Manual,
    }
}

/// Wrap a follow-up message for a TUI that is already running.
///
/// A later message has no command line to ride on, so it goes in through the
/// terminal — the same way a person's paste does. Bracketed paste is what
/// keeps a multi-line message one message: inside the markers a newline is a
/// character, not a submit. The carriage return comes after the closing
/// marker, where it means "send", exactly as if the person had pasted and
/// pressed enter.
///
/// Only offered to CLIs whose conventions are measured (`delivery_for`),
/// because a TUI that never enabled bracketed paste would see the markers as
/// keystrokes and every newline as its own submission — the agent acting on
/// point one of a review while still reading point five. Both measured CLIs
/// do enable it (`ESC [ ? 2004 h`, in the first frame either of them draws),
/// which `tests/agent_parity.rs` holds them to on a schedule; it is the one
/// assumption the whole review loop rests on, and it would not fail loudly.
pub fn bracketed_followup(text: &str) -> String {
    // A trailing newline would sit invisibly inside the paste and turn into a
    // blank line in the input box, not a submit — trim it rather than send it.
    let trimmed = text.trim_end_matches(['\n', '\r']);
    format!("\x1b[200~{trimmed}\x1b[201~\r")
}

pub fn template_path(data_dir: &Path) -> PathBuf {
    data_dir.join("prompt-template.md")
}

/// Read the template, writing the default out the first time.
///
/// Never overwrites: once someone has edited this, an upgrade that quietly
/// restored the stock wording would be indistinguishable from the edit having
/// silently failed.
pub fn load_or_create(data_dir: &Path) -> Result<String> {
    let path = template_path(data_dir);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        return Ok(existing);
    }
    std::fs::create_dir_all(data_dir)
        .with_context(|| format!("creating {}", data_dir.display()))?;
    std::fs::write(&path, DEFAULT_TEMPLATE)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(DEFAULT_TEMPLATE.to_string())
}

/// Fill the template in.
///
/// One pass, emitting either literal text or a substitution, so text that
/// comes *in* is never scanned for placeholders on the way out. A card whose
/// prompt happens to contain `{branch}` is describing a placeholder, not
/// asking for one.
pub fn render(template: &str, vars: &Vars) -> String {
    let short: String = vars.base_sha.chars().take(8).collect();
    let mut out = String::with_capacity(template.len() + vars.prompt.len());
    let mut saw_prompt = false;
    let mut saw_repos = false;
    let mut rest = template;

    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            // An unmatched brace is just a brace.
            out.push_str(&rest[open..]);
            return finish(out, saw_prompt, saw_repos, vars);
        };
        let key = &after[..close];
        let block;
        let value = match key {
            "title" => Some(vars.title),
            "branch" => Some(vars.branch),
            "base_branch" => Some(vars.base_branch),
            "base_sha" => Some(vars.base_sha),
            "base_sha_short" => Some(short.as_str()),
            "repos" => {
                saw_repos = true;
                block = repos_block(vars);
                Some(block.as_str())
            }
            "prompt" => {
                saw_prompt = true;
                Some(vars.prompt)
            }
            _ => None,
        };
        match value {
            Some(v) => out.push_str(v),
            // An unknown placeholder is left as written. Silently deleting it
            // would make a typo in the template look like the variable was
            // empty.
            None => {
                out.push('{');
                out.push_str(key);
                out.push('}');
            }
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    finish(out, saw_prompt, saw_repos, vars)
}

/// The two things a template can be edited into not saying, said anyway.
///
/// `{prompt}` is the older of the pair: dropping the person's actual request
/// on the floor is the one failure here that would be invisible from the
/// outside — the agent would start, look healthy, and work on nothing.
///
/// `{repos}` is the same shape of problem and reaches further, because every
/// template written before a card could span two repositories is a template
/// that does not mention it. Such a template describes one worktree to an
/// agent standing in a workspace, and the agent would go looking for the
/// files in the directory it woke up in and find folders instead. So when a
/// card really does span several, the paragraph is appended rather than
/// assumed — and when it spans one, nothing is added, because that template's
/// own wording already said everything true about the situation.
fn finish(mut out: String, saw_prompt: bool, saw_repos: bool, vars: &Vars) -> String {
    if !saw_repos && vars.trees.len() > 1 {
        let mut head = repos_block(vars);
        head.push_str("\n\n");
        head.push_str(&out);
        out = head;
    }
    if !saw_prompt && !vars.prompt.is_empty() {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("\n---\n\n");
        out.push_str(vars.prompt);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The ordinary card: one repository, so `trees` is the single checkout
    /// that sits at the session's own directory and wears no folder name.
    const ONE: &[TreeVar] = &[TreeVar {
        dir: "",
        repo: "/Users/me/code/web",
        base_branch: "main",
        base_sha: "2bc172c2deadbeefcafe",
    }];

    const TWO: &[TreeVar] = &[
        TreeVar {
            dir: "web",
            repo: "/Users/me/code/web",
            base_branch: "main",
            base_sha: "2bc172c2deadbeefcafe",
        },
        TreeVar {
            dir: "api",
            repo: "/Users/me/code/api",
            base_branch: "develop",
            base_sha: "91ab00ff1234",
        },
    ];

    fn vars<'a>(prompt: &'a str) -> Vars<'a> {
        Vars {
            title: "修好登入",
            branch: "marol/login-2",
            base_branch: "main",
            base_sha: "2bc172c2deadbeefcafe",
            trees: ONE,
            prompt,
        }
    }

    fn spanning<'a>(prompt: &'a str) -> Vars<'a> {
        Vars {
            trees: TWO,
            ..vars(prompt)
        }
    }

    #[test]
    fn the_default_template_names_the_situation_the_agent_cannot_discover() {
        let out = render(DEFAULT_TEMPLATE, &vars("登入頁在 Safari 會白畫面"));
        assert!(out.contains("修好登入"));
        assert!(out.contains("marol/login-2"));
        assert!(out.contains("main"));
        assert!(out.contains("2bc172c2"), "the base commit is missing:\n{out}");
        assert!(out.contains("登入頁在 Safari 會白畫面"));
        // The long sha must not appear where the short one was asked for.
        assert!(!out.contains("2bc172c2deadbeefcafe"));
    }

    /// A card's own prompt is text, not a template. Re-scanning what was
    /// substituted in is how a prompt that mentions `{branch}` ends up
    /// rewritten behind the person's back.
    #[test]
    fn placeholders_inside_the_users_own_prompt_are_left_as_written() {
        let out = render(
            "head\n{prompt}\n",
            &vars("template 裡的 {branch} 和 {title} 要保留原樣"),
        );
        assert!(
            out.contains("{branch}") && out.contains("{title}"),
            "the card's prompt was itself templated:\n{out}"
        );
    }

    #[test]
    fn an_unknown_placeholder_is_left_alone_rather_than_blanked() {
        let out = render("a {nonesuch} b {prompt}", &vars("p"));
        assert!(out.contains("{nonesuch}"), "{out}");
    }

    #[test]
    fn an_unmatched_brace_is_just_a_brace() {
        let out = render("cost is {50 {prompt}", &vars("p"));
        assert!(out.contains("{50"), "{out}");
    }

    /// The template is editable, so this is reachable: an edit that loses
    /// `{prompt}` would otherwise start the agent on nothing at all, and
    /// nothing about the session would look wrong.
    #[test]
    fn a_template_that_lost_its_prompt_placeholder_still_sends_the_request() {
        let out = render("[Marol] {title}\n", &vars("修好登入頁"));
        assert!(
            out.contains("修好登入頁"),
            "the card's actual request never reached the agent:\n{out}"
        );
    }

    #[test]
    fn a_short_base_sha_does_not_panic_when_shortened() {
        let out = render(
            "{base_sha_short}",
            &Vars {
                title: "t",
                branch: "b",
                base_branch: "main",
                base_sha: "abc",
                trees: &[],
                prompt: "p",
            },
        );
        assert!(out.starts_with("abc"));
    }

    /// A card spanning two repositories has to say so, and say which folder
    /// is which. The agent wakes up in a workspace; without this it would
    /// look for the files where it is standing and find directories.
    #[test]
    fn a_card_spanning_two_repositories_names_every_checkout() {
        let out = render(DEFAULT_TEMPLATE, &spanning("讓兩邊的欄位對得起來"));
        assert!(out.contains("web/"), "the first checkout is unnamed:\n{out}");
        assert!(out.contains("api/"), "the second checkout is unnamed:\n{out}");
        assert!(out.contains("/Users/me/code/api"), "{out}");
        // Each carries its own base — they are not required to match.
        assert!(out.contains("main"), "{out}");
        assert!(out.contains("develop"), "{out}");
        assert!(out.contains("91ab00ff"), "{out}");
        // One branch across both, which is what the review reads.
        assert_eq!(out.matches("marol/login-2").count(), 1, "{out}");
    }

    /// The one-repository wording is unchanged, down to not mentioning
    /// folders at all: that session's directory *is* the checkout, and
    /// telling it to `cd` somewhere would be telling it something false.
    #[test]
    fn one_repository_still_gets_the_sentence_it_always_got() {
        let out = render(DEFAULT_TEMPLATE, &vars("登入頁在 Safari 會白畫面"));
        assert!(out.contains("git worktree"), "{out}");
        assert!(!out.contains("工作區"), "a single checkout was called a workspace:\n{out}");
        assert!(!out.contains("- /"), "a single checkout was listed as a folder:\n{out}");
    }

    /// The `{prompt}` rule, applied to the newer placeholder. Every template
    /// on disk today was written before a card could span two repositories,
    /// and none of them mentions `{repos}` — so a card that does span two
    /// gets the paragraph anyway, rather than an agent told about one
    /// worktree while standing in a workspace.
    #[test]
    fn a_template_that_never_heard_of_workspaces_still_describes_one() {
        let old = "[Marol 任務] {title}\n\n你在一個 worktree：分支 {branch}。\n\n---\n\n{prompt}\n";
        let out = render(old, &spanning("兩邊一起改"));
        assert!(out.contains("web/") && out.contains("api/"), "{out}");
        // The person's own template is still there, and still first-class.
        assert!(out.contains("[Marol 任務] 修好登入"), "{out}");
        assert!(out.contains("兩邊一起改"), "{out}");

        // And a one-repository card gets nothing added: that template's own
        // wording already said everything true about its situation.
        let single = render(old, &vars("一邊改"));
        assert!(!single.contains("工作區"), "{single}");
    }

    /// Only the CLIs in the conventions table are sent a prompt. Guessing at
    /// another's would hand it an argument that might mean "print and exit".
    #[test]
    fn only_the_clis_we_measured_are_sent_a_prompt_automatically() {
        for measured in ["claude", "codex"] {
            assert_eq!(delivery_for(measured), Delivery::Positional, "{measured}");
        }
        for other in ["gemini", "aider", "something-new"] {
            assert_eq!(delivery_for(other), Delivery::Manual, "{other}");
        }
    }

    /// The property the whole review loop stands on: a multi-line follow-up
    /// arrives as one message. Newlines stay inside the paste markers, and
    /// the one carriage return — the submit — comes after they close.
    #[test]
    fn a_followup_keeps_its_newlines_inside_the_paste_and_submits_once() {
        let wrapped = bracketed_followup("第一點：修 auth.py\n第二點：補測試\n");
        assert!(wrapped.starts_with("\x1b[200~"));
        assert!(wrapped.ends_with("\x1b[201~\r"));
        // The message's own newlines are all inside the markers.
        let inside = wrapped
            .strip_prefix("\x1b[200~")
            .and_then(|s| s.strip_suffix("\x1b[201~\r"))
            .unwrap();
        assert_eq!(inside, "第一點：修 auth.py\n第二點：補測試");
        // And the only carriage return is the submit at the very end.
        assert_eq!(wrapped.matches('\r').count(), 1);
    }

    /// A trailing newline inside the paste would render as a blank line in
    /// the input box rather than submitting — trimmed, not trusted.
    #[test]
    fn a_followups_trailing_newlines_do_not_ride_inside_the_paste() {
        let wrapped = bracketed_followup("one line\n\n");
        assert!(wrapped.contains("one line\x1b[201~\r"), "{wrapped:?}");
    }

    #[test]
    fn an_edited_template_survives_the_next_launch() {
        let dir = std::env::temp_dir().join(format!("marol-tpl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let first = load_or_create(&dir).unwrap();
        assert_eq!(first, DEFAULT_TEMPLATE);

        std::fs::write(template_path(&dir), "我的版本 {prompt}").unwrap();
        assert_eq!(load_or_create(&dir).unwrap(), "我的版本 {prompt}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
