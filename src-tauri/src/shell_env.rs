//! Login-shell environment resolution.
//!
//! A GUI process launched from Finder or Dock inherits a stub environment:
//! `PATH` is roughly `/usr/bin:/bin:/usr/sbin:/sbin`, with none of the
//! version-manager shims, Homebrew prefixes or exported API keys the user's
//! terminal has. Handing that to a coding agent breaks `npx`-based MCP
//! servers, mise/asdf toolchains, and often the `claude` binary itself.
//!
//! So we ask the user's own login shell what its environment is, once, and
//! use that for every agent we spawn. This is the same trick VS Code and the
//! `fix-path` npm package use.

use anyhow::{anyhow, Result};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

/// Printed by the probe shell immediately before the env dump, so we can
/// discard anything the user's rc files echoed on the way (motd, version
/// manager banners, `nvm` chatter).
const MARKER: &str = "__AGENTDESK_ENV__";

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct ShellEnv {
    pub vars: HashMap<String, String>,
    /// Which shell answered, for the diagnostics panel.
    pub shell: String,
    /// False when the probe failed and we fell back to the process env.
    pub resolved: bool,
}

impl ShellEnv {
    pub fn path(&self) -> Option<&str> {
        self.vars.get("PATH").map(String::as_str)
    }

    /// Resolve an executable against the shell PATH rather than ours.
    pub fn which(&self, exe: &str) -> Option<PathBuf> {
        let path = self.path()?;
        for dir in path.split(':').filter(|d| !d.is_empty()) {
            let candidate = PathBuf::from(dir).join(exe);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
        None
    }

    /// Fallback used when the probe fails: this process's own environment.
    fn from_process(shell: String) -> Self {
        Self {
            vars: std::env::vars().collect(),
            shell,
            resolved: false,
        }
    }
}

#[cfg(unix)]
fn is_executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &std::path::Path) -> bool {
    p.is_file()
}

/// Ask the user's login shell for its environment.
///
/// Runs the shell interactive (`-i`) and as a login shell (`-l`) so both
/// `.zshrc`/`.bashrc` and `.zprofile`/`.bash_profile` are sourced — version
/// managers commonly install into one or the other.
pub async fn resolve() -> ShellEnv {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    match probe(&shell).await {
        Ok(vars) if !vars.is_empty() => ShellEnv {
            vars,
            shell,
            resolved: true,
        },
        Ok(_) => {
            eprintln!("[shell_env] probe returned nothing; using process env");
            ShellEnv::from_process(shell)
        }
        Err(e) => {
            eprintln!("[shell_env] probe failed ({e}); using process env");
            ShellEnv::from_process(shell)
        }
    }
}

async fn probe(shell: &str) -> Result<HashMap<String, String>> {
    // `env -0` is NUL-separated, so values containing newlines survive.
    let script = format!("printf '%s' '{MARKER}'; env -0");

    let child = tokio::process::Command::new(shell)
        .arg("-ilc")
        .arg(&script)
        // Some rc files skip work when they think they're non-interactive.
        .env("TERM", "xterm-256color")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output();

    let output = tokio::time::timeout(PROBE_TIMEOUT, child)
        .await
        .map_err(|_| anyhow!("timed out after {PROBE_TIMEOUT:?}"))??;

    if !output.status.success() {
        return Err(anyhow!("shell exited with {}", output.status));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let dump = stdout
        .split_once(MARKER)
        .map(|(_, after)| after)
        .ok_or_else(|| anyhow!("marker not found in shell output"))?;

    Ok(parse_env0(dump))
}

fn parse_env0(dump: &str) -> HashMap<String, String> {
    dump.split('\0')
        .filter(|entry| !entry.is_empty())
        .filter_map(|entry| {
            let (k, v) = entry.split_once('=')?;
            if k.is_empty() {
                return None;
            }
            Some((k.to_string(), v.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nul_separated_pairs() {
        let vars = parse_env0("PATH=/usr/bin:/bin\0HOME=/Users/x\0");
        assert_eq!(vars.get("PATH").unwrap(), "/usr/bin:/bin");
        assert_eq!(vars.get("HOME").unwrap(), "/Users/x");
        assert_eq!(vars.len(), 2);
    }

    #[test]
    fn keeps_values_containing_newlines_and_equals() {
        let vars = parse_env0("A=one\ntwo\0B=k=v\0");
        assert_eq!(vars.get("A").unwrap(), "one\ntwo");
        assert_eq!(vars.get("B").unwrap(), "k=v");
    }

    #[test]
    fn skips_malformed_entries() {
        let vars = parse_env0("GOOD=1\0nokv\0=novalue\0");
        assert_eq!(vars.len(), 1);
        assert!(vars.contains_key("GOOD"));
    }
}
