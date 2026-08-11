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

/* ------------------------------- the tray -------------------------------

The one surface that speaks while the window is closed, so what it says has
to be true of a desk that is *away* rather than stopped. Quitting detaches
the agents tmux is holding; it does not end them.
------------------------------------------------------------------------ */

pub fn tray_show(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "Open AgentDesk",
        Locale::ZhTw => "打開 AgentDesk",
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
        return "AgentDesk".to_string();
    }
    match locale {
        Locale::En => format!("AgentDesk: {waiting} waiting on you"),
        Locale::ZhTw => format!("AgentDesk：{waiting} 個等你"),
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
            assert_eq!(tray_tooltip(locale, 0), "AgentDesk");
            assert!(tray_tooltip(locale, 3).contains('3'));
            assert!(tray_tooltip(locale, 3).contains("AgentDesk"));
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
