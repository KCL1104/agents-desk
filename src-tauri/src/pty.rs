//! PTY-hosted agent sessions.
//!
//! A session is a real pseudo-terminal running the real `claude` binary, so
//! the pane shows exactly what a terminal shows: the same TUI chrome, the same
//! slash-command menu, the same permission prompts. Nothing is re-rendered or
//! reinterpreted on the way.
//!
//! Two details make it behave like a terminal rather than a pipe:
//!
//!   * `claude` detects a tty and runs its full interactive UI. Spawned with
//!     plain pipes it would fall back to non-interactive mode.
//!   * The environment comes from the user's login shell (`shell_env`), not
//!     from this GUI process, so version-manager shims and MCP servers resolve
//!     the same way they do in Terminal.app.

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use crate::shell_env::ShellEnv;

/// Output is forwarded in chunks rather than per byte; a redraw-heavy TUI can
/// emit thousands of small writes and one IPC message each would swamp the
/// webview.
const READ_BUF: usize = 8 * 1024;

/// tmux, used for exactly one thing: holding the agent's process after this
/// app exits.
///
/// **One server per session, never a shared one.** A tmux session inherits
/// the environment of the *server*, not of the client that asked for it, so
/// on a shared server every session after the first would be handed the
/// first one's `AGENTDESK_SESSION_ID` — measured, not feared: the second
/// session read back the first session's id. Cards would light up for the
/// wrong agent. A socket per session makes the environment right by
/// construction rather than by hope, and costs one idle process each.
///
/// tmux also never gets to draw. The config this desk writes turns the
/// status line off and unbinds every key, so it cannot repaint a cell or
/// swallow a keystroke — a byte tmux drew would be a byte the TUI did not,
/// and that is the one promise this app makes.
#[derive(Debug, Clone)]
pub struct Hold {
    /// The command that ends this session for good, already composed for the
    /// world it runs in: `tmux -L … kill-server` on this machine, the same
    /// thing behind a doorway anywhere else.
    ///
    /// Composed by the core rather than here. Which world a session lives in
    /// is the core's knowledge — `pty` opens a terminal onto a command and
    /// has never known whose machine that command lands on — and a hold that
    /// built its own tmux line could only ever build a local one.
    pub destroy: (String, Vec<String>),
    /// The socket's file, when it is on *this* machine. tmux leaves the inode
    /// behind when a server exits, so closing a session would otherwise leave
    /// a dead file that every later sweep has to look at. `None` for a socket
    /// in another world, whose filesystem this process cannot reach: the
    /// destroy command unlinks it there.
    pub socket_file: Option<String>,
}

/// The single session inside each socket. There is only ever one, so the
/// name carries no information and exists because tmux wants one.
pub const HOLD_SESSION: &str = "agent";

/// What `-f` points at. Written every app start.
pub const HOLD_CONF: &str = "\
set -g status off
set -g escape-time 0
set -g mouse off
set -g default-terminal \"screen-256color\"
set -ga terminal-overrides \",*:Tc\"
set -g destroy-unattached off
unbind-key -a
";

/// The command that starts a held session, or reattaches to the one already
/// running under this socket.
///
/// `new-session -A` is create-or-attach in one call, so a restart that finds
/// its session alive takes the same path as the start that made it: one code
/// path, and no window in which the two could disagree. `-D` detaches any
/// other client, because two attached clients would fight over the pty's
/// size.
///
/// Returned as a plain (program, args) pair so the caller can put it through
/// a doorway. That is the whole reason it lives here rather than inside
/// `spawn`: a tmux line built at spawn time is a tmux line on this machine,
/// and the worlds that need holding most are the other ones.
pub fn hold_attach(
    socket: &str,
    conf: &str,
    cwd: Option<&str>,
    program: &str,
    args: &[String],
) -> (String, Vec<String>) {
    let mut a = vec![
        "-L".to_string(),
        socket.to_string(),
        "-f".to_string(),
        conf.to_string(),
        "new-session".to_string(),
        "-A".to_string(),
        "-D".to_string(),
        "-s".to_string(),
        HOLD_SESSION.to_string(),
    ];
    if let Some(dir) = cwd {
        a.push("-c".to_string());
        a.push(dir.to_string());
    }
    a.push("--".to_string());
    a.push(program.to_string());
    a.extend(args.iter().cloned());
    ("tmux".to_string(), a)
}

/// The command that ends one for good.
///
/// `kill-server`, not `kill-session`: this socket holds exactly one session,
/// so ending it should not leave a server behind waiting for a session that
/// will never come.
pub fn hold_destroy(socket: &str) -> (String, Vec<String>) {
    (
        "tmux".to_string(),
        vec!["-L".to_string(), socket.to_string(), "kill-server".to_string()],
    )
}

/// The socket name for one session of one desk.
///
/// `desk` distinguishes installs sharing a machine — without it, one desk's
/// orphan sweep would happily kill another's live agents, and the tests
/// would do it to each other.
pub fn hold_socket(desk: &str, session_id: &str) -> String {
    format!("agentdesk-{desk}-{session_id}")
}

/// A short, stable tag for a desk, from wherever it keeps its data.
///
/// FNV-1a because it needs to be stable across runs and short enough to read
/// in `tmux -L`, not because anything here is a secret.
pub fn desk_tag(data_dir: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in data_dir.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    format!("{:08x}", h as u32)
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// How to end the tmux server holding this session, when one is. Resolved
    /// at spawn so the close path needs no environment of its own.
    destroy: Option<(std::path::PathBuf, Vec<String>, Option<String>)>,
    /// Everything the terminal has emitted, bounded.
    ///
    /// A PTY starts producing the moment it is spawned, but the pane that
    /// displays it only mounts on the next render. Without a replay buffer the
    /// whole first paint — for Claude Code, its entire opening screen — is
    /// emitted to nobody and the pane comes up blank.
    scrollback: Arc<Mutex<Scrollback>>,
}

/// Bounded byte buffer with a monotonic sequence number, so a late-attaching
/// pane can be handed the history *and* know which live chunks it has already
/// been given.
#[derive(Default)]
pub struct Scrollback {
    bytes: Vec<u8>,
    /// Sequence of the most recent chunk appended.
    pub seq: u64,
}

/// Roughly a few full screens of a redraw-heavy TUI.
const SCROLLBACK_LIMIT: usize = 512 * 1024;

impl Scrollback {
    fn append(&mut self, chunk: &[u8]) -> u64 {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > SCROLLBACK_LIMIT {
            // Drop from the front. A TUI repaints from escape sequences, so a
            // truncated prefix costs history, never correctness of the frame.
            let excess = self.bytes.len() - SCROLLBACK_LIMIT;
            self.bytes.drain(0..excess);
        }
        self.seq += 1;
        self.seq
    }

    fn snapshot(&self) -> (String, u64) {
        (BASE64.encode(&self.bytes), self.seq)
    }
}

impl PtySession {
    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow!("resize failed: {e}"))
    }

    /// End the client. When tmux is holding the process this only detaches:
    /// the session has `destroy-unattached off`, so the agent keeps running.
    /// That is exactly what quitting the app should do.
    pub fn kill(&mut self) {
        let _ = self.child.kill();
    }

    /// End the session for good, tmux's server included.
    ///
    /// The deliberate close, as opposed to quitting the app. Without this the
    /// two would be indistinguishable from here — the client dies either way,
    /// and only one of them means "I am finished with this work".
    pub fn destroy(&mut self) {
        if let Some((tmux, args, socket_file)) = self.destroy.clone() {
            let _ = std::process::Command::new(tmux).args(args).output();
            // The server exits; its socket inode does not. Closing a session
            // should leave nothing at all behind.
            if let Some(f) = socket_file {
                let _ = std::fs::remove_file(f);
            }
        }
        let _ = self.child.kill();
    }
}

/// What a spawned session reports back.
pub trait PtySink: Send + Sync + 'static {
    /// A chunk of terminal output, base64-encoded, with its sequence number.
    ///
    /// Bytes, not text. A read boundary lands wherever the kernel put it, so
    /// decoding each chunk as UTF-8 here would replace any multi-byte
    /// character that straddles the boundary with U+FFFD — and a TUI is full
    /// of 3-byte box-drawing characters, so the frame would visibly break
    /// apart. Passing bytes through lets the terminal emulator's own
    /// stateful decoder stitch the boundary back together.
    fn on_output(&self, id: &str, data: String, seq: u64);
    /// The process exited with this status string.
    fn on_exit(&self, id: &str, status: String);
}

#[derive(Default)]
pub struct PtyRegistry {
    sessions: Mutex<HashMap<String, PtySession>>,
}

impl PtyRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Launch `program` under a PTY in `cwd`.
    ///
    /// `program` is resolved against the login-shell PATH, so `claude`,
    /// `codex` or any other agent CLI is found the same way the user's shell
    /// finds it.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        id: &str,
        program: &str,
        args: &[String],
        // `None` when the real working directory only exists inside a host
        // (a WSL distro): the outer process runs from wherever the app is,
        // and the wrapping carries the true cwd across.
        cwd: Option<&str>,
        env: &ShellEnv,
        // Per-session variables layered on top of the shell environment — how
        // a status hook learns which session it is reporting for.
        extra_env: &[(String, String)],
        cols: u16,
        rows: u16,
        sink: Arc<dyn PtySink>,
        // When set, the command above is already a tmux line (see
        // `hold_attach`) and this carries what it takes to end it. `None`
        // runs the command as a direct child, the way every world without
        // tmux still does.
        hold: Option<&Hold>,
    ) -> Result<()> {
        if self.sessions.lock().unwrap().contains_key(id) {
            return Err(anyhow!("session {id} already has a terminal"));
        }

        let exe = env
            .which(program)
            .ok_or_else(|| anyhow!("`{program}` not found on the login-shell PATH"))?;

        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow!("openpty failed: {e}"))?;

        // CreateProcessW runs the resolved path as the process image, and a
        // batch file is not an image — only cmd.exe can host one. npm
        // installs `claude` on Windows as exactly such a shim (claude.cmd),
        // so the shim rides as cmd's argument instead.
        let batch = exe
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
        let mut cmd = if batch {
            let comspec = env
                .vars
                .get("COMSPEC")
                .or_else(|| env.vars.get("ComSpec"))
                .map(String::as_str)
                .unwrap_or("cmd.exe");
            let mut c = CommandBuilder::new(comspec);
            c.arg("/c");
            c.arg(&exe);
            for a in args {
                c.arg(a);
            }
            c
        } else {
            let mut c = CommandBuilder::new(&exe);
            for a in args {
                c.arg(a);
            }
            c
        };
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }
        for (k, v) in &env.vars {
            cmd.env(k, v);
        }
        // A TUI needs a terminal type it can drive; the login shell's own TERM
        // may be `dumb` when the probe ran non-interactively.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Layered last so per-session values win over the shell's.
        for (k, v) in extra_env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .with_context(|| format!("spawning {}", exe.display()))?;
        // Dropping the slave lets the master see EOF when the child exits.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow!("cloning pty reader failed: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| anyhow!("taking pty writer failed: {e}"))?;

        let session_id = id.to_string();
        let out_sink = Arc::clone(&sink);
        let scrollback = Arc::new(Mutex::new(Scrollback::default()));
        let reader_scrollback = Arc::clone(&scrollback);
        // Blocking reads on a dedicated thread: portable-pty's reader has no
        // async interface, and a TUI stream is effectively continuous.
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_BUF];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        // Record before emitting, so a pane that attaches
                        // between the two sees this chunk in the snapshot
                        // rather than missing it in both.
                        let seq = reader_scrollback.lock().unwrap().append(&buf[..n]);
                        out_sink.on_output(&session_id, BASE64.encode(&buf[..n]), seq);
                    }
                    Err(e) => {
                        eprintln!("[pty] {session_id} read error: {e}");
                        break;
                    }
                }
            }
            out_sink.on_exit(&session_id, "closed".to_string());
        });

        self.sessions.lock().unwrap().insert(
            id.to_string(),
            PtySession {
                master: pair.master,
                writer,
                child,
                // Resolved through the login-shell PATH, like every other
                // program this app runs, rather than left as a bare name for
                // `Command` to find on the process PATH. Those two disagree —
                // a Homebrew tmux is on one and not the other — and a destroy
                // that silently cannot find its tmux would leave the server
                // running with nothing left to attach to it.
                destroy: hold.and_then(|h| {
                    env.which(&h.destroy.0)
                        .map(|exe| (exe, h.destroy.1.clone(), h.socket_file.clone()))
                }),
                scrollback,
            },
        );

        Ok(())
    }

    /// Everything this terminal has produced so far, plus the sequence number
    /// it ends at. A pane subscribes first, calls this, writes the snapshot,
    /// then replays only the live chunks newer than `seq` — so nothing is
    /// dropped and nothing is written twice.
    pub fn snapshot(&self, id: &str) -> Result<(String, u64)> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get(id)
            .ok_or_else(|| anyhow!("no terminal for session {id}"))?;
        let sb = s.scrollback.lock().unwrap();
        Ok(sb.snapshot())
    }

    pub fn write(&self, id: &str, data: &str) -> Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get_mut(id)
            .ok_or_else(|| anyhow!("no terminal for session {id}"))?;
        s.write(data.as_bytes())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let s = sessions
            .get(id)
            .ok_or_else(|| anyhow!("no terminal for session {id}"))?;
        s.resize(cols, rows)
    }

    /// Close one session for good — tmux's copy of it included.
    pub fn kill(&self, id: &str) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(id) {
            s.destroy();
        }
    }

    /// Quitting the app.
    ///
    /// Deliberately `kill`, not `destroy`: a directly-spawned child dies with
    /// its client, which is the old behaviour and still right, while a held
    /// session only loses its viewer. That difference is the whole feature —
    /// quitting is not the same as being finished with the work.
    pub fn kill_all(&self) {
        let mut sessions = self.sessions.lock().unwrap();
        for (_, mut s) in sessions.drain() {
            s.kill();
        }
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(id)
    }
}

#[cfg(test)]
mod hold_tests {
    use super::*;

    /// The config is the whole safety argument: tmux holds the process and
    /// draws nothing. A status line or a live key binding would put bytes on
    /// screen the TUI did not write, which is the one thing this app promises
    /// never happens.
    #[test]
    fn the_config_leaves_tmux_nothing_to_draw_and_no_key_to_eat() {
        assert!(HOLD_CONF.contains("set -g status off"));
        assert!(HOLD_CONF.contains("unbind-key -a"));
        // Detaching must not be the same as ending: the app quitting drops
        // the client, and the agent has to survive that.
        assert!(HOLD_CONF.contains("set -g destroy-unattached off"));
        // Truecolor survives the wrapping, or every themed TUI loses its
        // palette the moment a world gains tmux.
        assert!(HOLD_CONF.contains("*:Tc"));
    }

    /// The socket carries both the desk and the session. Without the desk,
    /// one install's orphan sweep would kill another's live agents — and two
    /// tests running at once would do it to each other.
    #[test]
    fn a_socket_belongs_to_one_desk_and_one_session() {
        let a = hold_socket(&desk_tag("/home/me/.agentdesk"), "s7");
        let b = hold_socket(&desk_tag("/home/me/.agentdesk-beta"), "s7");
        assert_ne!(a, b);
        assert!(a.starts_with("agentdesk-"));
        assert!(a.ends_with("-s7"));
        // Stable across runs, or a restart would fail to find its own.
        assert_eq!(desk_tag("/home/me/.agentdesk"), desk_tag("/home/me/.agentdesk"));
    }

    /// The line that starts or reattaches, and the two things about it that
    /// are load-bearing.
    ///
    /// `-A` is create-or-attach, so the first start and every later reattach
    /// are the same call and cannot drift apart. `--` is what stops tmux
    /// reading the agent's own flags: `claude --continue --permission-mode
    /// acceptEdits` past a tmux that is still parsing options is a tmux that
    /// eats them, and the agent then starts without the mode the person
    /// approved.
    #[test]
    fn the_attach_line_is_create_or_attach_and_hands_the_agent_its_own_flags() {
        let (prog, args) = hold_attach(
            "agentdesk-d-s1",
            "/data/tmux.conf",
            Some("/wt/card-1"),
            "claude",
            &["--continue".to_string(), "--permission-mode".to_string(), "acceptEdits".to_string()],
        );
        // A pair, not a spawn: this is what lets the whole line go through a
        // doorway into another world.
        assert_eq!(prog, "tmux");
        assert!(args.contains(&"-A".to_string()), "not create-or-attach: {args:?}");
        assert!(args.contains(&"-D".to_string()), "two clients would fight over the size");

        let sep = args.iter().position(|a| a == "--").expect("no -- separator");
        let after: Vec<&String> = args[sep + 1..].iter().collect();
        assert_eq!(after[0], "claude");
        assert_eq!(after[1], "--continue");
        assert_eq!(after[3], "acceptEdits");
        // Everything tmux is meant to read is on tmux's side of it.
        assert!(args[..sep].contains(&"/data/tmux.conf".to_string()));
        assert!(args[..sep].contains(&"/wt/card-1".to_string()));
    }

    /// Ending it kills the server, not the session: this socket holds exactly
    /// one, so a surviving server would be a daemon waiting for something
    /// that is never coming back.
    #[test]
    fn ending_a_held_session_takes_its_server_with_it() {
        let (prog, args) = hold_destroy("agentdesk-d-s1");
        assert_eq!(prog, "tmux");
        assert!(args.contains(&"kill-server".to_string()), "{args:?}");
        assert!(!args.contains(&"kill-session".to_string()));
        assert!(args.contains(&"agentdesk-d-s1".to_string()), "wrong socket: {args:?}");
    }

    /// The reason there is a socket per session at all, stated as a test so
    /// nobody "optimises" it back into a shared server: a tmux session
    /// inherits the *server's* environment, so on a shared server the second
    /// session reads back the first one's id — measured, not feared.
    #[test]
    fn a_socket_per_session_is_what_makes_the_environment_right() {
        assert_ne!(
            hold_socket(&desk_tag("/d"), "s1"),
            hold_socket(&desk_tag("/d"), "s2"),
        );
    }
}
