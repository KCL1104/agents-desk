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
pub const MARKER: &str = "__AGENTDESK_ENV__";

const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Variables a running Claude Code injects into the processes it spawns.
///
/// The probe shell is our child, so it inherits whatever launched AgentDesk.
/// From Finder that is nothing; from a terminal inside a Claude Code session
/// it is these, and they describe *that* session rather than any setting the
/// user chose. Passing them to a fresh agent makes it behave as that session's
/// child — `CLAUDE_CODE_CHILD_SESSION` in particular turns transcript saving
/// off, which leaves `--continue` with nothing to continue: reopening an
/// attempt would silently start over instead of resuming.
///
/// Matched exactly rather than by prefix. `CLAUDE_CODE_*` is also where real
/// user configuration lives — `CLAUDE_CODE_USE_BEDROCK` and friends — and a
/// prefix rule would quietly break the setup of anyone who sets one.
const INHERITED_SESSION_MARKERS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_EXECPATH",
];

fn strip_session_markers(vars: &mut HashMap<String, String>) {
    for marker in INHERITED_SESSION_MARKERS {
        vars.remove(*marker);
    }
}

#[derive(Debug, Clone)]
pub struct ShellEnv {
    pub vars: HashMap<String, String>,
    /// Which shell answered, for the diagnostics panel.
    pub shell: String,
    /// False when the probe failed and we fell back to the process env.
    pub resolved: bool,
}

impl ShellEnv {
    /// 讀一個環境變數,照平台的規矩:Windows 的鍵不分大小寫 —— 真實
    /// 行程從登錄檔拿到的是 `Path` 而不是 `PATH`,精確比對會把整條
    /// PATH 看成不存在,claude 就此隱形(claude-detect 的 windows 腿
    /// 第一天就抓到)。Unix 上維持精確:大小寫是不同的變數,這是規矩。
    fn var_ci(&self, key: &str) -> Option<&str> {
        if let Some(v) = self.vars.get(key) {
            return Some(v.as_str());
        }
        if cfg!(windows) {
            return self
                .vars
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v.as_str());
        }
        None
    }

    pub fn path(&self) -> Option<&str> {
        self.var_ci("PATH")
    }

    /// Resolve an executable against the shell PATH rather than ours.
    ///
    /// `split_paths` speaks each platform's separator — a bare `':'` split
    /// would shred every `C:\…` entry on Windows into drive-letter confetti,
    /// which is exactly the bug that made a real machine's `claude`
    /// undetectable. Windows also never stores a bare `claude`: the native
    /// installer writes `claude.exe`, npm writes `claude.cmd`, so the name
    /// is expanded through PATHEXT there.
    pub fn which(&self, exe: &str) -> Option<PathBuf> {
        let path = self.path()?;
        let pathext = if cfg!(windows) {
            Some(self.var_ci("PATHEXT").unwrap_or(".COM;.EXE;.BAT;.CMD"))
        } else {
            None
        };
        let names = candidate_names(exe, pathext);
        for dir in std::env::split_paths(path).filter(|d| !d.as_os_str().is_empty()) {
            for name in &names {
                let candidate = dir.join(name);
                if is_executable(&candidate) {
                    return Some(candidate);
                }
            }
        }
        None
    }

    /// Fallback used when the probe fails: this process's own environment.
    fn from_process(shell: String) -> Self {
        let mut vars: HashMap<String, String> = std::env::vars().collect();
        strip_session_markers(&mut vars);
        Self {
            vars,
            shell,
            resolved: false,
        }
    }
}

/// The file names `exe` may resolve to on disk.
///
/// Without PATHEXT (Unix) the name is exactly itself. With it (Windows) the
/// name is tried as given only when it already carries an extension
/// (`wsl.exe`), then with each PATHEXT extension appended. The bare name is
/// deliberately *not* a candidate there: CreateProcess cannot run an
/// extensionless file, and npm drops exactly such a `claude` — a POSIX-shell
/// shim for git-bash — next to `claude.cmd`; matching it first would resolve
/// to a file only bash can execute.
fn candidate_names(exe: &str, pathext: Option<&str>) -> Vec<String> {
    let Some(exts) = pathext else {
        return vec![exe.to_string()];
    };
    let mut names = Vec::new();
    if std::path::Path::new(exe).extension().is_some() {
        names.push(exe.to_string());
    }
    for ext in exts.split(';').filter(|e| !e.is_empty()) {
        names.push(format!("{exe}{}", ext.to_ascii_lowercase()));
    }
    names
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
    // Windows has no login-shell gap to bridge: a GUI process inherits the
    // user's full environment (registry PATH included), and there is no
    // rc-file shell to ask. The process env is the real answer there, not
    // a degraded fallback — so it reads as resolved.
    if cfg!(windows) {
        let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut env = ShellEnv::from_process(shell);
        env.resolved = true;
        return env;
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    match probe(&shell).await {
        Ok(mut vars) if !vars.is_empty() => {
            strip_session_markers(&mut vars);
            ShellEnv {
                vars,
                shell,
                resolved: true,
            }
        }
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

/// Shared with `host`, which asks the same question of a WSL distro's shell.
pub fn parse_env0(dump: &str) -> HashMap<String, String> {
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

    /// CI 的守門測試:AGENTDESK_EXPECT_CLAUDE=1 表示這台 runner 真的裝了
    /// Claude Code —— 那 app 自己的解析路徑(login-shell 探測 → 平台正確
    /// 的 PATH 行走 → Windows 的 PATHEXT 展開)就必須找得到它;找不到是
    /// 錯,不是可容忍的環境差異。沒作此承諾的機器上自跳,本機不強求。
    #[test]
    fn a_promised_real_claude_is_found_by_the_apps_own_resolution() {
        if std::env::var("AGENTDESK_EXPECT_CLAUDE").as_deref() != Ok("1") {
            eprintln!("skip: AGENTDESK_EXPECT_CLAUDE != 1");
            return;
        }
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let env = rt.block_on(resolve());
        assert!(env.resolved, "the environment probe fell back to the process env");
        let found = env.which("claude");
        assert!(
            found.is_some(),
            "claude is promised on this machine but the resolved PATH cannot see it:\n{:?}",
            env.path()
        );
        eprintln!("claude resolved at {}", found.unwrap().display());
    }

    /// 登錄檔寫的是 `Path`;找不找得到不該取決於誰打的大小寫。
    #[test]
    fn windows_reads_path_case_insensitively_unix_exactly() {
        let mut vars = HashMap::new();
        vars.insert("Path".to_string(), "C:\\somewhere".to_string());
        let env = ShellEnv { vars, shell: "cmd.exe".into(), resolved: true };
        if cfg!(windows) {
            assert_eq!(env.path(), Some("C:\\somewhere"));
        } else {
            assert_eq!(env.path(), None, "unix keys stay case-sensitive");
        }
    }

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

    /// Unix knows exactly one spelling of a program's name.
    #[test]
    fn without_pathext_the_name_is_itself() {
        assert_eq!(candidate_names("claude", None), vec!["claude"]);
    }

    /// Windows never stores a bare `claude` — the native installer writes
    /// `claude.exe`, npm writes `claude.cmd` — and npm *also* drops an
    /// extensionless `claude` (a POSIX-shell shim) in the same directory.
    /// The bare name must not be a candidate, or that shim wins and the
    /// probe resolves to a file only bash can run.
    #[test]
    fn pathext_expands_a_bare_name_and_skips_the_sh_shim() {
        let names = candidate_names("claude", Some(".COM;.EXE;.BAT;.CMD"));
        assert_eq!(names, vec!["claude.com", "claude.exe", "claude.bat", "claude.cmd"]);
    }

    /// A name that already carries its extension (`wsl.exe`) is complete,
    /// and the exact spelling is tried first.
    #[test]
    fn a_name_with_an_extension_is_tried_as_given_first() {
        let names = candidate_names("wsl.exe", Some(".COM;.EXE"));
        assert_eq!(names[0], "wsl.exe");
    }

    /// The which() seam itself, on a real directory: the resolver must keep
    /// finding Unix executables now that the PATH walk goes through
    /// `split_paths` instead of a hand-rolled `':'` split.
    #[cfg(unix)]
    #[test]
    fn which_still_resolves_against_a_real_unix_path() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("agentdesk-which-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("claude");
        std::fs::write(&exe, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut env = ShellEnv {
            vars: HashMap::new(),
            shell: "test".into(),
            resolved: true,
        };
        env.vars.insert(
            "PATH".into(),
            format!("/nonexistent:{}", dir.display()),
        );
        assert_eq!(env.which("claude"), Some(exe));
        assert_eq!(env.which("missing"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Measured: launching AgentDesk from a terminal inside a Claude Code
    /// session leaks that session's markers through the probe shell, and
    /// `CLAUDE_CODE_CHILD_SESSION` turns transcript saving off. A session
    /// spawned that way looks fine and then has nothing for `--continue` to
    /// resume, which is how reopening an attempt loses its history.
    #[test]
    fn a_session_marker_inherited_from_our_own_launcher_is_not_passed_on() {
        let mut vars = parse_env0(
            "PATH=/usr/bin\0CLAUDECODE=1\0CLAUDE_CODE_CHILD_SESSION=1\0\
             CLAUDE_CODE_SESSION_ID=abc\0CLAUDE_CODE_ENTRYPOINT=cli\0\
             CLAUDE_CODE_SSE_PORT=1234\0CLAUDE_CODE_EXECPATH=/x/claude\0",
        );
        strip_session_markers(&mut vars);
        assert_eq!(vars.keys().collect::<Vec<_>>(), vec!["PATH"]);
    }

    /// The same prefix carries real user configuration, which must survive.
    /// A blanket `CLAUDE_CODE_*` rule would silently break anyone on Bedrock.
    #[test]
    fn user_configuration_sharing_the_prefix_is_left_alone() {
        let mut vars = parse_env0(
            "CLAUDE_CODE_USE_BEDROCK=1\0CLAUDE_CODE_MAX_OUTPUT_TOKENS=8192\0CLAUDECODE=1\0",
        );
        strip_session_markers(&mut vars);
        assert_eq!(vars.get("CLAUDE_CODE_USE_BEDROCK").unwrap(), "1");
        assert_eq!(vars.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS").unwrap(), "8192");
        assert!(!vars.contains_key("CLAUDECODE"));
    }
}
