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

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
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

    pub fn kill(&mut self) {
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
            c
        } else {
            CommandBuilder::new(&exe)
        };
        for a in args {
            cmd.arg(a);
        }
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

    pub fn kill(&self, id: &str) {
        if let Some(mut s) = self.sessions.lock().unwrap().remove(id) {
            s.kill();
        }
    }

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
