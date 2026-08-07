//! The first message an attempt sends.
//!
//! The agent already has everything it can discover for itself: `CLAUDE.md`,
//! skills, and MCP servers all load natively from the worktree, so repeating
//! any of that here would only crowd out the part that matters. What it
//! cannot discover is the situation AgentDesk has just put it in — that this
//! directory is a worktree opened for one card, which branch it is on, and
//! that the branch is what the diff and the merge will read. That, and the
//! person's actual request, is all this template carries.
//!
//! It is written to disk on first run and never overwritten, so editing it is
//! a supported thing to do rather than a change that gets reverted on upgrade.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

/// Written in Chinese to match the prompts these cards carry. An agent
/// answers in the language it was addressed in, and a bilingual first message
/// makes it drift mid-session.
pub const DEFAULT_TEMPLATE: &str = r#"[AgentDesk 任務] {title}

你在一個專為這張卡開的 git worktree：分支 {branch}，從 {base_branch} @ {base_sha_short} 開出。
這個 worktree 只屬於這張卡，不要切換分支，也不要動 {base_branch}。
完成時請把變更 commit 在這個分支上 —— AgentDesk 用它來做 diff 檢視與合併回 base。

---

{prompt}
"#;

pub struct Vars<'a> {
    pub title: &'a str,
    pub branch: &'a str,
    pub base_branch: &'a str,
    pub base_sha: &'a str,
    pub prompt: &'a str,
}

/// How a given CLI is told what to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    /// Hand the rendered prompt over as the positional argument.
    ///
    /// Measured, because none of it is documented: the prompt keeps the
    /// interactive TUI (`-p` is what makes it non-interactive), a multi-line
    /// string arrives as **one** message rather than one per line, and it
    /// survives the trust prompt a new worktree always opens on.
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

pub fn delivery_for(agent: &str) -> Delivery {
    match agent {
        "claude" => Delivery::Positional,
        _ => Delivery::Manual,
    }
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
    let mut rest = template;

    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            // An unmatched brace is just a brace.
            out.push_str(&rest[open..]);
            return finish(out, saw_prompt, vars.prompt);
        };
        let key = &after[..close];
        let value = match key {
            "title" => Some(vars.title),
            "branch" => Some(vars.branch),
            "base_branch" => Some(vars.base_branch),
            "base_sha" => Some(vars.base_sha),
            "base_sha_short" => Some(short.as_str()),
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
    finish(out, saw_prompt, vars.prompt)
}

/// The template is editable, so it can be edited into one that never mentions
/// `{prompt}`. Dropping the person's actual request on the floor is the one
/// failure here that would be invisible from the outside — the agent would
/// start, look healthy, and work on nothing.
fn finish(mut out: String, saw_prompt: bool, prompt: &str) -> String {
    if !saw_prompt && !prompt.is_empty() {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("\n---\n\n");
        out.push_str(prompt);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars<'a>(prompt: &'a str) -> Vars<'a> {
        Vars {
            title: "修好登入",
            branch: "agentdesk/login-2",
            base_branch: "main",
            base_sha: "2bc172c2deadbeefcafe",
            prompt,
        }
    }

    #[test]
    fn the_default_template_names_the_situation_the_agent_cannot_discover() {
        let out = render(DEFAULT_TEMPLATE, &vars("登入頁在 Safari 會白畫面"));
        assert!(out.contains("修好登入"));
        assert!(out.contains("agentdesk/login-2"));
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
        let out = render("[AgentDesk] {title}\n", &vars("修好登入頁"));
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
                prompt: "p",
            },
        );
        assert!(out.starts_with("abc"));
    }

    /// Only Claude Code's conventions have been measured. Guessing at another
    /// CLI's would hand it an argument that might mean "print and exit".
    #[test]
    fn only_the_cli_we_measured_is_sent_a_prompt_automatically() {
        assert_eq!(delivery_for("claude"), Delivery::Positional);
        for other in ["codex", "gemini", "aider", "something-new"] {
            assert_eq!(delivery_for(other), Delivery::Manual, "{other}");
        }
    }

    #[test]
    fn an_edited_template_survives_the_next_launch() {
        let dir = std::env::temp_dir().join(format!("agentdesk-tpl-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let first = load_or_create(&dir).unwrap();
        assert_eq!(first, DEFAULT_TEMPLATE);

        std::fs::write(template_path(&dir), "我的版本 {prompt}").unwrap();
        assert_eq!(load_or_create(&dir).unwrap(), "我的版本 {prompt}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
