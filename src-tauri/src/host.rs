//! Where a repository — and everything that runs against it — actually lives.
//!
//! The app runs *here*; a repository can live *somewhere else that can run
//! commands*: a WSL distro today, an SSH host next. Everything AgentDesk does
//! with an environment reduces to three acts — spawn a PTY, run a command and
//! read its output, receive a hook callback — so a host is exactly the thing
//! that wraps the first two. (The third degrades gracefully by design: status
//! reporting is a nicety, sessions are not.)
//!
//! A host rides inside the paths the app already stores, so nothing about the
//! database changes shape:
//!
//! ```text
//! /Users/me/code/app              the machine the app runs on
//! wsl://Ubuntu/home/me/code/app   the Ubuntu distro under WSL
//! ssh://devbox/home/me/app        reserved — refused until the SSH host lands
//! ```
//!
//! Inside a non-local host every path is the host's own (POSIX), and is
//! handled as a string: `PathBuf` on Windows joins with backslashes, which
//! would quietly corrupt a WSL path.
//!
//! Two environments are always in play, and `HostRef` carries both: the app
//! machine's login environment finds the *doorway* (`wsl.exe`), and the
//! host's own resolved environment finds what runs *inside* (`claude`, `git`,
//! `gh`). Environment variables do not cross the WSL boundary on their own
//! (that is WSLENV's job, and it needs per-variable annotations), so commands
//! are wrapped as `wsl.exe -d <distro> --cd <dir> -e env K=V… <program>
//! <args…>`: `-e` skips the shell so argv — including a multi-line prompt —
//! arrives exactly as sent, and POSIX `env` carries the variables and
//! resolves the program against the PATH it was handed.

use anyhow::{anyhow, Result};

use crate::shell_env::ShellEnv;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Host {
    Local,
    Wsl { distro: String },
}

/// A stored path, split into who runs it and what it is called there.
#[derive(Debug, Clone, PartialEq)]
pub struct Located {
    pub host: Host,
    /// The path as the host itself sees it.
    pub path: String,
}

/// Read a stored path. Plain paths are local, `wsl://distro/...` is that
/// distro, and `ssh://` is named so its refusal can say "not yet" instead of
/// "no such directory".
pub fn locate(raw: &str) -> Result<Located> {
    if let Some(rest) = raw.strip_prefix("wsl://") {
        let (distro, path) = rest
            .split_once('/')
            .ok_or_else(|| anyhow!("`{raw}` names a distro but no path — wsl://<distro>/<path>"))?;
        if distro.is_empty() {
            return Err(anyhow!("`{raw}` names no distro — wsl://<distro>/<path>"));
        }
        return Ok(Located {
            host: Host::Wsl {
                distro: distro.to_string(),
            },
            path: format!("/{path}"),
        });
    }
    if raw.starts_with("ssh://") {
        return Err(anyhow!(
            "ssh:// repositories are not supported yet — WSL landed first"
        ));
    }
    Ok(Located {
        host: Host::Local,
        path: raw.to_string(),
    })
}

/// Put a host-side path back into the form the app stores.
pub fn stored(host: &Host, path: &str) -> String {
    match host {
        Host::Local => path.to_string(),
        Host::Wsl { distro } => format!("wsl://{distro}{path}"),
    }
}

/// The short badge a card wears for a non-local host: `wsl:Ubuntu`.
pub fn label(host: &Host) -> Option<String> {
    match host {
        Host::Local => None,
        Host::Wsl { distro } => Some(format!("wsl:{distro}")),
    }
}

/// `C:\Users\me\x` → `/mnt/c/Users/me/x`, for handing an app-side file (the
/// hooks plugin) to a program inside WSL, which sees Windows drives mounted
/// under `/mnt`. A path that is not drive-lettered passes through — in tests
/// and on non-Windows hosts the two sides share one filesystem.
pub fn win_path_for_wsl(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest: String = path[3..].replace('\\', "/");
        return format!("/mnt/{drive}/{rest}");
    }
    path.to_string()
}

impl Host {
    /// Join a path the way the host spells paths. Non-local hosts are POSIX;
    /// using `PathBuf` for them on Windows would join with backslashes.
    pub fn join(&self, base: &str, leaf: &str) -> String {
        match self {
            Host::Local => std::path::Path::new(base)
                .join(leaf)
                .to_string_lossy()
                .to_string(),
            Host::Wsl { .. } => format!("{}/{leaf}", base.trim_end_matches('/')),
        }
    }

    /// Wrap `program args…` so it runs inside this host, in `cwd`, with
    /// `envs` set. Returns what to actually spawn *here*, plus the working
    /// directory the outer process needs — `None` when the real cwd only
    /// exists inside the host.
    pub fn wrap<'a>(
        &self,
        program: &str,
        args: &[String],
        cwd: Option<&'a str>,
        envs: &[(String, String)],
    ) -> (String, Vec<String>, Option<&'a str>) {
        match self {
            // Locally the caller applies cwd and env natively, as it always
            // has; wrapping would only add a process to every spawn.
            Host::Local => (program.to_string(), args.to_vec(), cwd),
            Host::Wsl { distro } => {
                let mut wrapped = vec!["-d".to_string(), distro.clone()];
                if let Some(dir) = cwd {
                    wrapped.push("--cd".to_string());
                    wrapped.push(dir.to_string());
                }
                wrapped.push("-e".to_string());
                // `env` even when there is nothing to set: the wrapping has
                // one shape, and `env prog` is exactly `prog`.
                wrapped.push("env".to_string());
                for (k, v) in envs {
                    wrapped.push(format!("{k}={v}"));
                }
                wrapped.push(program.to_string());
                wrapped.extend(args.iter().cloned());
                ("wsl.exe".to_string(), wrapped, None)
            }
        }
    }

    /// Resolve the host's own login environment — the same question
    /// `shell_env::resolve` answers locally: what PATH, and therefore which
    /// `claude`, `git` and `gh`, does a person's terminal in this host get.
    ///
    /// `--shell-type login` runs the probe through the user's default shell
    /// as a login shell, so version-manager PATH entries are present. `-0`
    /// keeps values containing newlines whole, exactly as the local probe
    /// does.
    pub fn probe_env(&self, local: &ShellEnv) -> Result<ShellEnv> {
        match self {
            Host::Local => Ok(local.clone()),
            Host::Wsl { distro } => {
                let out = std::process::Command::new(wsl_exe(local))
                    .args(["-d", distro, "--shell-type", "login", "--", "env", "-0"])
                    .output()
                    .map_err(|e| anyhow!("running wsl.exe for `{distro}`: {e}"))?;
                if !out.status.success() {
                    return Err(anyhow!(
                        "could not read `{distro}`'s environment: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
                let vars = crate::shell_env::parse_env0(&String::from_utf8_lossy(&out.stdout));
                if vars.get("PATH").is_none() {
                    return Err(anyhow!("`{distro}`'s environment came back without a PATH"));
                }
                Ok(ShellEnv {
                    vars,
                    shell: format!("wsl:{distro}"),
                    resolved: true,
                })
            }
        }
    }
}

/// The doorway binary, found on the app machine's own login PATH. On real
/// Windows that is System32's `wsl.exe`; in tests it is whatever stands in
/// for it.
fn wsl_exe(local: &ShellEnv) -> std::path::PathBuf {
    local
        .which("wsl.exe")
        .unwrap_or_else(|| std::path::PathBuf::from("wsl.exe"))
}

/// A host together with both environments commands need: the app machine's
/// (`local`, which finds `wsl.exe`) and the host's own (`env`, whose PATH
/// finds what runs inside). Built by the core from its per-host cache and
/// handed to everything that executes.
#[derive(Clone, Copy)]
pub struct HostRef<'a> {
    pub host: &'a Host,
    pub local: &'a ShellEnv,
    pub env: &'a ShellEnv,
}

impl HostRef<'_> {
    pub fn join(&self, base: &str, leaf: &str) -> String {
        self.host.join(base, leaf)
    }

    /// Run a command inside the host to completion.
    pub fn run(&self, program: &str, args: &[&str], cwd: Option<&str>) -> Result<std::process::Output> {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        match self.host {
            Host::Local => {
                let exe = self
                    .env
                    .which(program)
                    .ok_or_else(|| anyhow!("`{program}` not found on the login-shell PATH"))?;
                let mut cmd = std::process::Command::new(exe);
                cmd.args(&owned).envs(&self.env.vars);
                if let Some(dir) = cwd {
                    cmd.current_dir(dir);
                }
                Ok(cmd.output()?)
            }
            Host::Wsl { .. } => {
                let carried = carry_env(self.env);
                let (_, wrapped, _) = self.host.wrap(program, &owned, cwd, &carried);
                Ok(std::process::Command::new(wsl_exe(self.local))
                    .args(wrapped)
                    .output()?)
            }
        }
    }

    /// `run`, then insist it worked, then hand back trimmed stdout.
    pub fn run_ok(&self, program: &str, args: &[&str], cwd: Option<&str>) -> Result<String> {
        let out = self.run(program, args, cwd)?;
        if !out.status.success() {
            return Err(anyhow!(
                "{program} {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    /// Whether `path` is a directory inside the host.
    pub fn is_dir(&self, path: &str) -> bool {
        match self.host {
            Host::Local => std::path::Path::new(path).is_dir(),
            Host::Wsl { .. } => self
                .run("test", &["-d", path], None)
                .map(|o| o.status.success())
                .unwrap_or(false),
        }
    }

    /// Whether `path` exists at all inside the host.
    pub fn exists(&self, path: &str) -> bool {
        match self.host {
            Host::Local => std::path::Path::new(path).exists(),
            Host::Wsl { .. } => self
                .run("test", &["-e", path], None)
                .map(|o| o.status.success())
                .unwrap_or(false),
        }
    }

    pub fn mkdir_p(&self, path: &str) -> Result<()> {
        match self.host {
            Host::Local => Ok(std::fs::create_dir_all(path)?),
            Host::Wsl { .. } => {
                self.run_ok("mkdir", &["-p", path], None)?;
                Ok(())
            }
        }
    }

    /// The file's text, `None` when it does not exist. Existence and
    /// readability are separated so a real read failure is an error, not a
    /// silent "no config" — the M6 rule, kept across the boundary.
    pub fn read_to_string(&self, path: &str) -> Result<Option<String>> {
        match self.host {
            Host::Local => match std::fs::read_to_string(path) {
                Ok(t) => Ok(Some(t)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            },
            Host::Wsl { .. } => {
                if !self.exists(path) {
                    return Ok(None);
                }
                // Raw stdout, not `run_ok`'s trim: file text is content.
                let out = self.run("cat", &[path], None)?;
                if !out.status.success() {
                    return Err(anyhow!(
                        "reading {path}: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    ));
                }
                Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
            }
        }
    }
}

/// The variables worth carrying into a WSL command. The whole login
/// environment would be the ideal, but it rides on `wsl.exe`'s command line,
/// which is a Windows command line with a Windows-sized limit — so what
/// crosses is what commands actually resolve and run by: the host's own PATH
/// (probed, so version-manager shims are on it) and HOME.
fn carry_env(env: &ShellEnv) -> Vec<(String, String)> {
    ["PATH", "HOME"]
        .iter()
        .filter_map(|k| env.vars.get(*k).map(|v| (k.to_string(), v.clone())))
        .collect()
}

/// The per-session extras a PTY launch carries across, on top of `carry_env`.
pub fn pty_env(env: &ShellEnv, extra: &[(String, String)]) -> Vec<(String, String)> {
    let mut vars = carry_env(env);
    vars.push(("TERM".to_string(), "xterm-256color".to_string()));
    vars.push(("COLORTERM".to_string(), "truecolor".to_string()));
    vars.extend(extra.iter().cloned());
    vars
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paths_stay_local_and_round_trip() {
        let l = locate("/Users/me/code/app").unwrap();
        assert_eq!(l.host, Host::Local);
        assert_eq!(l.path, "/Users/me/code/app");
        assert_eq!(stored(&l.host, &l.path), "/Users/me/code/app");
        assert_eq!(label(&l.host), None);
    }

    #[test]
    fn a_wsl_url_names_the_distro_and_keeps_the_posix_path() {
        let l = locate("wsl://Ubuntu/home/me/code/app").unwrap();
        assert_eq!(
            l.host,
            Host::Wsl {
                distro: "Ubuntu".into()
            }
        );
        assert_eq!(l.path, "/home/me/code/app");
        assert_eq!(stored(&l.host, &l.path), "wsl://Ubuntu/home/me/code/app");
        assert_eq!(label(&l.host).as_deref(), Some("wsl:Ubuntu"));
    }

    #[test]
    fn a_wsl_url_without_a_distro_or_path_is_refused_plainly() {
        assert!(locate("wsl://").is_err());
        assert!(locate("wsl://Ubuntu").is_err());
        assert!(locate("wsl:///home/me").is_err());
    }

    /// Reserved, and refused with "not yet" — a person typing it should learn
    /// the truth, not chase a phantom "no such directory".
    #[test]
    fn ssh_urls_are_refused_as_not_yet_rather_than_misread() {
        let err = locate("ssh://devbox/home/me/app").unwrap_err();
        assert!(err.to_string().contains("not supported yet"), "{err}");
    }

    /// The wrapped command line is the contract with wsl.exe: no shell in the
    /// middle, so a multi-line prompt is one argv entry the whole way.
    #[test]
    fn wrapping_for_wsl_carries_cwd_env_and_argv_without_a_shell() {
        let host = Host::Wsl {
            distro: "Ubuntu".into(),
        };
        let (prog, args, outer_cwd) = host.wrap(
            "claude",
            &["--plugin-dir".into(), "/mnt/c/p".into(), "多行\nprompt".into()],
            Some("/home/me/wt"),
            &[("AGENTDESK_SESSION_ID".into(), "s1".into())],
        );
        assert_eq!(prog, "wsl.exe");
        assert_eq!(
            args,
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/home/me/wt",
                "-e",
                "env",
                "AGENTDESK_SESSION_ID=s1",
                "claude",
                "--plugin-dir",
                "/mnt/c/p",
                "多行\nprompt"
            ]
        );
        // The real cwd only exists inside the distro.
        assert_eq!(outer_cwd, None);
    }

    #[test]
    fn wrapping_locally_is_the_identity() {
        let (prog, args, cwd) = Host::Local.wrap(
            "claude",
            &["--continue".into()],
            Some("/tmp/x"),
            &[("K".into(), "V".into())],
        );
        assert_eq!(prog, "claude");
        assert_eq!(args, vec!["--continue"]);
        assert_eq!(cwd, Some("/tmp/x"));
    }

    /// The hooks plugin lives on the app's disk; a claude inside WSL reads it
    /// through the drive mounts.
    #[test]
    fn a_windows_path_translates_to_its_mnt_mount() {
        assert_eq!(
            win_path_for_wsl(r"C:\Users\me\AppData\AgentDesk\plugin"),
            "/mnt/c/Users/me/AppData/AgentDesk/plugin"
        );
        assert_eq!(win_path_for_wsl("D:/code/x"), "/mnt/d/code/x");
        // Already-POSIX paths pass through — tests and shared filesystems.
        assert_eq!(win_path_for_wsl("/data/plugin"), "/data/plugin");
    }

    /// Non-local paths are joined as strings: `PathBuf` on Windows would
    /// insert backslashes into a POSIX path.
    #[test]
    fn host_side_paths_join_with_forward_slashes() {
        let wsl = Host::Wsl {
            distro: "Ubuntu".into(),
        };
        assert_eq!(wsl.join("/home/me/", "x"), "/home/me/x");
        assert_eq!(wsl.join("/home/me", "x"), "/home/me/x");
    }

    /// What crosses the boundary is bounded on purpose: the host's own PATH
    /// so programs resolve, HOME so config is found — never the whole dump,
    /// which would ride a Windows-sized command line.
    #[test]
    fn only_path_and_home_are_carried_across() {
        let mut env = ShellEnv {
            vars: Default::default(),
            shell: "sh".into(),
            resolved: true,
        };
        env.vars.insert("PATH".into(), "/nvm/bin:/usr/bin".into());
        env.vars.insert("HOME".into(), "/home/me".into());
        env.vars.insert("SECRET".into(), "x".into());
        let carried = carry_env(&env);
        assert!(carried.contains(&("PATH".into(), "/nvm/bin:/usr/bin".into())));
        assert!(carried.contains(&("HOME".into(), "/home/me".into())));
        assert!(!carried.iter().any(|(k, _)| k == "SECRET"));
    }
}
