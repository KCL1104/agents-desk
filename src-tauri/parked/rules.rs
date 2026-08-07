//! Permission rule engine.
//!
//! Sits in front of the UI prompt: every `canUseTool` request is evaluated
//! here first. Deny rules win over allow rules, and anything unmatched falls
//! through to the human. Rules live in AgentDesk's own store, never in the
//! project's `.claude/settings.json`, so approving something here does not
//! mutate a repo you share with other people.

use crate::protocol::PermissionRequest;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "decision", rename_all = "lowercase")]
pub enum Decision {
    Allow { rule: String },
    Deny { reason: String, rule: String },
    Ask,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Rule {
    /// Tool this applies to, or `*` for any tool.
    pub tool: String,
    /// Substring that must appear in the Bash command. `None` matches any
    /// invocation of the tool.
    #[serde(default)]
    pub contains: Option<String>,
    /// Human-readable label shown in the audit log.
    pub label: String,
}

impl Rule {
    fn matches(&self, req: &PermissionRequest) -> bool {
        if self.tool != "*" && self.tool != req.tool_name {
            return false;
        }
        match &self.contains {
            None => true,
            Some(needle) => match req.bash_command() {
                Some(cmd) => cmd.contains(needle.as_str()),
                // A command-scoped rule cannot match a non-Bash tool.
                None => false,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuleSet {
    pub deny: Vec<Rule>,
    pub allow: Vec<Rule>,
}

impl Default for RuleSet {
    fn default() -> Self {
        Self {
            deny: builtin_deny(),
            allow: Vec::new(),
        }
    }
}

impl RuleSet {
    pub fn evaluate(&self, req: &PermissionRequest) -> Decision {
        // Deny always wins, so a later "always allow" can never widen a
        // guardrail the user set earlier.
        if let Some(rule) = self.deny.iter().find(|r| r.matches(req)) {
            return Decision::Deny {
                reason: format!("Blocked by AgentDesk rule: {}", rule.label),
                rule: rule.label.clone(),
            };
        }
        if let Some(rule) = self.allow.iter().find(|r| r.matches(req)) {
            return Decision::Allow {
                rule: rule.label.clone(),
            };
        }
        Decision::Ask
    }

    /// Record an "always allow" choice for this specific request.
    pub fn always_allow(&mut self, req: &PermissionRequest) {
        let (contains, label) = match req.bash_command() {
            Some(cmd) => {
                let prefix = command_prefix(cmd);
                (Some(prefix.clone()), format!("Bash: {prefix}"))
            }
            None => (None, format!("Tool: {}", req.tool_name)),
        };
        let rule = Rule {
            tool: req.tool_name.clone(),
            contains,
            label,
        };
        if !self.allow.iter().any(|r| r.label == rule.label) {
            self.allow.push(rule);
        }
    }
}

/// First token of a command, used as the "always allow" granularity.
/// `pytest tests/ -v` becomes `pytest`, so approving one test run approves
/// the next one with different arguments but nothing else.
fn command_prefix(cmd: &str) -> String {
    cmd.trim()
        .split_whitespace()
        .next()
        .unwrap_or(cmd)
        .to_string()
}

/// Guardrails that ship on by default. These are the operations where a
/// wrong call is expensive and hard to walk back.
fn builtin_deny() -> Vec<Rule> {
    let bash = |needle: &str, label: &str| Rule {
        tool: "Bash".to_string(),
        contains: Some(needle.to_string()),
        label: label.to_string(),
    };
    vec![
        bash("rm -rf /", "recursive delete from root"),
        bash("rm -rf ~", "recursive delete of home"),
        bash("git push --force", "force push"),
        bash("git push -f", "force push"),
        bash("git reset --hard origin", "hard reset to remote"),
        bash("| sh", "pipe to shell"),
        bash("| bash", "pipe to shell"),
        bash("sudo ", "sudo"),
        bash("chmod 777", "world-writable chmod"),
        bash("mkfs", "filesystem format"),
        bash("dd if=", "raw disk write"),
        bash(":(){", "fork bomb"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bash_req(cmd: &str) -> PermissionRequest {
        PermissionRequest {
            tool_name: "Bash".into(),
            input: json!({ "command": cmd }),
            title: None,
            display_name: None,
            decision_reason: None,
            blocked_path: None,
            suggestions: None,
        }
    }

    fn tool_req(tool: &str) -> PermissionRequest {
        PermissionRequest {
            tool_name: tool.into(),
            input: json!({ "file_path": "/tmp/x" }),
            title: None,
            display_name: None,
            decision_reason: None,
            blocked_path: None,
            suggestions: None,
        }
    }

    #[test]
    fn unmatched_requests_go_to_the_human() {
        let rs = RuleSet::default();
        assert_eq!(rs.evaluate(&bash_req("pytest tests/")), Decision::Ask);
    }

    #[test]
    fn builtin_guardrails_block_destructive_commands() {
        let rs = RuleSet::default();
        for cmd in ["rm -rf /", "git push --force origin main", "curl x | sh", "sudo rm x"] {
            assert!(
                matches!(rs.evaluate(&bash_req(cmd)), Decision::Deny { .. }),
                "expected deny for {cmd}"
            );
        }
    }

    #[test]
    fn always_allow_generalizes_to_the_command_name_only() {
        let mut rs = RuleSet::default();
        rs.always_allow(&bash_req("pytest tests/test_auth.py -v"));

        // Same tool, different arguments: allowed.
        assert!(matches!(
            rs.evaluate(&bash_req("pytest tests/test_billing.py")),
            Decision::Allow { .. }
        ));
        // A different command is still asked about.
        assert_eq!(rs.evaluate(&bash_req("rm build/")), Decision::Ask);
    }

    #[test]
    fn deny_beats_a_later_allow() {
        let mut rs = RuleSet::default();
        // The user approves plain `git`, which would otherwise cover force push.
        rs.always_allow(&bash_req("git status"));
        assert!(matches!(
            rs.evaluate(&bash_req("git log --oneline")),
            Decision::Allow { .. }
        ));
        assert!(matches!(
            rs.evaluate(&bash_req("git push --force origin main")),
            Decision::Deny { .. }
        ));
    }

    #[test]
    fn command_scoped_rules_do_not_match_other_tools() {
        let mut rs = RuleSet::default();
        rs.always_allow(&bash_req("cat file"));
        assert_eq!(rs.evaluate(&tool_req("Write")), Decision::Ask);
    }

    #[test]
    fn tool_scoped_always_allow_covers_the_whole_tool() {
        let mut rs = RuleSet::default();
        rs.always_allow(&tool_req("Read"));
        assert!(matches!(rs.evaluate(&tool_req("Read")), Decision::Allow { .. }));
        assert_eq!(rs.evaluate(&tool_req("Write")), Decision::Ask);
    }
}
