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
        Locale::ZhTw => "完成了一輪，等你看",
    }
}

/// The notification the environment panel's test button fires.
pub fn test_title(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "Notifications are working",
        Locale::ZhTw => "通知正常",
    }
}

pub fn test_body(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "This is what a session's notification looks like.",
        Locale::ZhTw => "session 的通知就長這樣。",
    }
}

/// Title of the notification raised when a queued card cannot be started.
pub fn queued_start_failed(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "A queued task could not start",
        Locale::ZhTw => "排隊中的 task 起不來",
    }
}

/// Name of the tab created for a brand-new install.
pub fn default_tab_name(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "Workspace",
        Locale::ZhTw => "工作區",
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
