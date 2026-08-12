//! The few strings the Rust side renders itself.
//!
//! Almost everything the user reads is drawn by the webview, which has its own
//! catalogue. What lands here is the handful of strings the OS renders for us:
//! native notification titles and bodies, and the name given to the first tab
//! before there is any interface to rename it in.
//!
//! The webview owns the choice — it is where the picker lives and where the
//! preference is stored — and pushes it down through `set_locale`. That keeps
//! one source of truth for the language and avoids two detection rules that
//! could disagree.

use std::sync::atomic::{AtomicU8, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    En,
    ZhTw,
}

impl Locale {
    /// Parses a BCP 47 tag. Anything starting `zh` is Chinese; everything else
    /// falls back to English, matching the webview's own detection.
    pub fn parse(tag: &str) -> Self {
        if tag.to_ascii_lowercase().starts_with("zh") {
            Locale::ZhTw
        } else {
            Locale::En
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => Locale::ZhTw,
            _ => Locale::En,
        }
    }

    fn as_u8(self) -> u8 {
        match self {
            Locale::En => 0,
            Locale::ZhTw => 1,
        }
    }
}

/// The current language, shared without locking.
///
/// An atomic rather than a `Mutex` because it is written once in a while from
/// a command and read on the notification path, which runs while session state
/// is already held elsewhere. There is nothing to co-ordinate with, so there is
/// nothing worth a lock.
#[derive(Debug, Default)]
pub struct LocaleCell(AtomicU8);

impl LocaleCell {
    pub fn get(&self) -> Locale {
        Locale::from_u8(self.0.load(Ordering::Relaxed))
    }

    pub fn set(&self, locale: Locale) {
        self.0.store(locale.as_u8(), Ordering::Relaxed);
    }
}

/// Why a session is asking for you, as a notification body.
pub fn waiting_permission(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "needs your permission to continue",
        Locale::ZhTw => "需要你授權才能繼續",
    }
}

pub fn awaiting_trust(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "is waiting for you to trust this folder",
        Locale::ZhTw => "在等你確認這個資料夾",
    }
}

pub fn waiting_input(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "is waiting on you",
        Locale::ZhTw => "在等你回覆",
    }
}

/// A turn ended while the window was elsewhere. Opt-in — every turn ends.
pub fn turn_done(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "finished its turn",
        Locale::ZhTw => "完成了一輪",
    }
}

/// The notification the environment panel's test button fires.
pub fn test_title(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "Notifications are working",
        Locale::ZhTw => "通知正常",
    }
}

/// Empty on purpose: the title already says notifications work, and the
/// notification the user is reading is itself the demonstration.
pub fn test_body(_locale: Locale) -> &'static str {
    ""
}

/// Title of the notification raised when a queued card cannot be started.
pub fn queued_start_failed(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "A queued task could not start",
        Locale::ZhTw => "排隊中的 task 無法啟動",
    }
}

/// Name of the tab created for a brand-new install.
pub fn default_tab_name(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "Workspace",
        Locale::ZhTw => "工作區",
    }
}

/* ------------------------------- the tray -------------------------------

The one surface that speaks while the window is closed, so what it says has
to be true of a desk that is *away* rather than stopped. Quitting detaches
the agents tmux is holding; it does not end them.
------------------------------------------------------------------------ */

pub fn tray_show(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "Open Marol",
        Locale::ZhTw => "打開 Marol",
    }
}

pub fn tray_quit(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "Quit",
        Locale::ZhTw => "結束",
    }
}

/// The text beside the icon, where the platform draws one.
///
/// Empty while nothing waits. A tray that always says its own name spends a
/// permanent slice of the menu bar to tell you nothing, which is the same
/// rule the board's status edge already keeps: colour is an event, not a
/// stripe. No language of its own — a count and a warning sign read the same
/// in both.
pub fn tray_title(waiting: usize) -> String {
    if waiting == 0 {
        String::new()
    } else {
        format!("⚠ {waiting}")
    }
}

/// The hover text. Windows has no label beside the icon, so this is the
/// whole message there, and it says it in words rather than a glyph.
pub fn tray_tooltip(locale: Locale, waiting: usize) -> String {
    if waiting == 0 {
        return "Marol".to_string();
    }
    match locale {
        Locale::En => format!("Marol: {waiting} waiting on you"),
        Locale::ZhTw => format!("Marol：{waiting} 個等你"),
    }
}

/* ---------------------------- refusals ----------------------------------

Everything below is rendered by the core rather than the webview, because it
is decided deep inside git work and reaches the interface as a plain error
string. `FriendlyError` shows what it does not recognise verbatim, so these
are read exactly as written — which is why they were the one surface still
speaking only Chinese to every user.

Same rule as the catalogue: name what is in the way and stop. What to do
about uncommitted work is not something a person running coding agents needs
told.
------------------------------------------------------------------------ */

/// The attempt's own worktree has work that a merge would silently drop.
pub fn merge_dirty_worktree(locale: Locale, branch: &str) -> String {
    match locale {
        Locale::En => format!("{branch} has uncommitted changes; a merge would not include them."),
        Locale::ZhTw => format!("{branch} 有未提交的變更，合併不會包含。"),
    }
}

/// The repository is checked out somewhere other than the base.
pub fn merge_wrong_branch(locale: Locale, on: &str, base_branch: &str) -> String {
    match locale {
        Locale::En => format!("This repo is on `{on}`, not `{base_branch}`."),
        Locale::ZhTw => format!("這個 repo 目前在 `{on}`，不是 `{base_branch}`。"),
    }
}

/// The base branch's own working tree is dirty, so merging into it would mix
/// somebody else's edits into the attempt's landing.
pub fn merge_dirty_base(locale: Locale, base_branch: &str) -> String {
    match locale {
        Locale::En => format!("`{base_branch}`'s working tree has uncommitted changes."),
        Locale::ZhTw => format!("`{base_branch}` 的工作目錄有未提交的變更。"),
    }
}

/// Nothing to fold back.
pub fn merge_nothing_ahead(locale: Locale, branch: &str, base_branch: &str) -> String {
    match locale {
        Locale::En => format!("{branch} has no commits `{base_branch}` does not already have."),
        Locale::ZhTw => format!("{branch} 沒有任何 `{base_branch}` 還沒有的 commit。"),
    }
}

/// A push would leave the uncommitted half behind.
pub fn push_dirty(locale: Locale, branch: &str) -> String {
    match locale {
        Locale::En => format!("{branch} has uncommitted changes; the push would not include them."),
        Locale::ZhTw => format!("{branch} 有未提交的變更，推送不會包含。"),
    }
}

/// Opening a pull request is `gh`'s job, and `gh` is not here.
pub fn gh_missing(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "`gh` is not on this environment's PATH.",
        Locale::ZhTw => "`gh` 不在這個環境的 PATH 上。",
    }
}

/// `gh` ran and refused. Its own stderr is the payload and is never
/// translated — it is the tool's answer, not ours.
pub fn gh_failed(locale: Locale, stderr: &str) -> String {
    match locale {
        Locale::En => format!("gh pr create failed: {stderr}"),
        Locale::ZhTw => format!("gh pr create 失敗：{stderr}"),
    }
}

/// One card, two hosts. Names the two that clashed and stops: which one to
/// change is the reader's call, and they can see both.
pub fn repos_cross_host(locale: Locale, first: &str, other: &str) -> String {
    match locale {
        Locale::En => {
            format!("All repos on a card must be on the same host: {first} and {other} are not.")
        }
        Locale::ZhTw => format!("同一張卡的 repo 必須在同一台主機：{first} 和 {other} 不是。"),
    }
}

pub fn repo_twice(locale: Locale, repo: &str) -> String {
    match locale {
        Locale::En => format!("{repo} appears twice on this card."),
        Locale::ZhTw => format!("{repo} 在這張卡上出現了兩次。"),
    }
}

/// A card spanning several repositories merged some and then failed. Which
/// ones already landed is the disclosure that makes the failure recoverable.
pub fn merge_partial(locale: Locale, repo: &str, err: &str, landed: &str) -> String {
    let landed = if landed.is_empty() { none(locale) } else { landed };
    match locale {
        Locale::En => format!("{repo} failed to merge: {err}\nAlready merged: {landed}"),
        Locale::ZhTw => format!("{repo} 合併失敗：{err}\n已合併：{landed}"),
    }
}

/// The same, for pull requests. The URLs already opened are one per line.
pub fn pr_partial(locale: Locale, repo: &str, err: &str, opened: &str) -> String {
    match locale {
        Locale::En => format!("{repo} failed to open a PR: {err}\nAlready opened:\n{opened}"),
        Locale::ZhTw => format!("{repo} 開 PR 失敗：{err}\n已開好：\n{opened}"),
    }
}

/// What joins a list of repository paths. `、` in Chinese, `, ` in English —
/// the same split the webview catalogue makes between `sep` and `listSep`.
pub fn list_sep(locale: Locale) -> &'static str {
    match locale {
        Locale::En => ", ",
        Locale::ZhTw => "、",
    }
}

fn none(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "(none)",
        Locale::ZhTw => "（沒有）",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn any_chinese_tag_is_chinese_and_everything_else_is_english() {
        for tag in ["zh", "zh-TW", "zh-Hant-TW", "ZH-cn"] {
            assert_eq!(Locale::parse(tag), Locale::ZhTw, "{tag} should be Chinese");
        }
        for tag in ["en", "en-GB", "ja", "de-DE", ""] {
            assert_eq!(Locale::parse(tag), Locale::En, "{tag} should be English");
        }
    }

    #[test]
    fn the_cell_round_trips_and_defaults_to_english() {
        let cell = LocaleCell::default();
        assert_eq!(cell.get(), Locale::En);
        cell.set(Locale::ZhTw);
        assert_eq!(cell.get(), Locale::ZhTw);
        cell.set(Locale::En);
        assert_eq!(cell.get(), Locale::En);
    }

    /// Nothing waiting is nothing said. The tray label is the one string
    /// that occupies screen for as long as the app is alive, so an idle desk
    /// has to give the space back — and the moment it has something to
    /// report, it must be countable rather than merely present.
    #[test]
    fn the_tray_is_silent_until_it_has_a_number() {
        assert_eq!(tray_title(0), "");
        assert!(tray_title(1).contains('1'));
        assert!(tray_title(12).contains("12"));
        // The tooltip carries the whole message on Windows, where there is
        // no label beside the icon at all, so it never goes empty.
        for locale in [Locale::En, Locale::ZhTw] {
            assert_eq!(tray_tooltip(locale, 0), "Marol");
            assert!(tray_tooltip(locale, 3).contains('3'));
            assert!(tray_tooltip(locale, 3).contains("Marol"));
        }
        // Two languages, two menus. A tray built once in English and never
        // rebuilt is the failure this pins.
        assert_ne!(tray_show(Locale::En), tray_show(Locale::ZhTw));
        assert_ne!(tray_quit(Locale::En), tray_quit(Locale::ZhTw));
    }

    /// The bodies are glued after a session title, so a leading capital or a
    /// trailing full stop would read wrong in the composed string.
    #[test]
    fn english_bodies_read_as_clauses_following_a_title() {
        for body in [
            waiting_permission(Locale::En),
            awaiting_trust(Locale::En),
            waiting_input(Locale::En),
            turn_done(Locale::En),
        ] {
            let first = body.chars().next().unwrap();
            assert!(first.is_lowercase(), "{body:?} should not start capitalised");
            assert!(!body.ends_with('.'), "{body:?} should not end with a stop");
        }
    }
}
