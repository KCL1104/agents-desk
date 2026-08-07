//! Supervises the Node sidecar that hosts the Agent SDK.
//!
//! One process for all sessions. The `claude` child process the SDK spawns
//! per session already provides isolation, so a second layer of per-session
//! Node processes would only cost memory.

use anyhow::{anyhow, Context, Result};
use std::path::PathBuf;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::protocol::{HostFrame, SidecarFrame};
use crate::shell_env::ShellEnv;

pub struct Sidecar {
    tx: mpsc::UnboundedSender<HostFrame>,
}

impl Sidecar {
    /// Send a frame. Returns an error only if the sidecar has exited.
    pub fn send(&self, frame: HostFrame) -> Result<()> {
        self.tx
            .send(frame)
            .map_err(|_| anyhow!("sidecar is not running"))
    }
}

/// Locate `dist/agent-host.mjs`.
///
/// `AGENTDESK_SIDECAR` wins, then the bundled resource, then the dev tree
/// relative to the executable (`target/debug/agentdesk` -> repo root).
fn resolve_script() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("AGENTDESK_SIDECAR") {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Ok(p);
        }
        return Err(anyhow!("AGENTDESK_SIDECAR points at {p:?}, which is not a file"));
    }

    let exe = std::env::current_exe().context("current_exe")?;
    let mut candidates = Vec::new();

    // Bundled next to the binary.
    if let Some(dir) = exe.parent() {
        candidates.push(dir.join("agent-host.mjs"));
        // Dev tree. The binary sits at varying depths — `target/debug/` for a
        // normal build, `target/debug/deps/` for a test binary — so walk up
        // rather than assuming one.
        candidates.extend(
            dir.ancestors()
                .map(|a| a.join("sidecar/dist/agent-host.mjs")),
        );
    }

    // Last resort: relative to the working directory and its parents.
    if let Ok(cwd) = std::env::current_dir() {
        candidates.extend(
            cwd.ancestors()
                .map(|a| a.join("sidecar/dist/agent-host.mjs")),
        );
    }

    candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| {
            anyhow!(
                "could not find agent-host.mjs. Run `npm --prefix sidecar run build`, \
                 or set AGENTDESK_SIDECAR. Looked in: {candidates:?}"
            )
        })
}

/// Start the sidecar. Returns a handle for sending, and a receiver of
/// everything it emits.
pub async fn spawn(env: &ShellEnv) -> Result<(Sidecar, mpsc::UnboundedReceiver<SidecarFrame>)> {
    let script = resolve_script()?;
    let node = env
        .which("node")
        .ok_or_else(|| {
            anyhow!(
                "`node` not found on the login-shell PATH ({:?}). AgentDesk needs Node 20+.",
                env.path().unwrap_or("<none>")
            )
        })?;

    eprintln!("[sidecar] {} {}", node.display(), script.display());

    let mut child = tokio::process::Command::new(&node)
        .arg(&script)
        .envs(&env.vars)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("spawning {}", node.display()))?;

    let mut stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;

    let (tx_out, mut rx_out) = mpsc::unbounded_channel::<HostFrame>();
    let (tx_in, rx_in) = mpsc::unbounded_channel::<SidecarFrame>();

    // Writer: serialize host frames as NDJSON.
    tokio::spawn(async move {
        while let Some(frame) = rx_out.recv().await {
            let mut line = match serde_json::to_vec(&frame) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[sidecar] encode failed: {e}");
                    continue;
                }
            };
            line.push(b'\n');
            if let Err(e) = stdin.write_all(&line).await {
                eprintln!("[sidecar] write failed: {e}");
                break;
            }
            if let Err(e) = stdin.flush().await {
                eprintln!("[sidecar] flush failed: {e}");
                break;
            }
        }
    });

    // Reader: parse NDJSON into typed frames.
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<SidecarFrame>(trimmed) {
                        Ok(frame) => {
                            if tx_in.send(frame).is_err() {
                                break; // core dropped the receiver
                            }
                        }
                        Err(e) => eprintln!(
                            "[sidecar] undecodable frame ({e}): {}",
                            &trimmed[..trimmed.len().min(200)]
                        ),
                    }
                }
                Ok(None) => {
                    eprintln!("[sidecar] stdout closed");
                    break;
                }
                Err(e) => {
                    eprintln!("[sidecar] read failed: {e}");
                    break;
                }
            }
        }
    });

    // Reap, so an early crash is visible rather than silent.
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => eprintln!("[sidecar] exited: {status}"),
            Err(e) => eprintln!("[sidecar] wait failed: {e}"),
        }
    });

    Ok((Sidecar { tx: tx_out }, rx_in))
}
