//! Rust side of the sidecar NDJSON protocol. Mirrors `sidecar/src/protocol.ts`.
//!
//! Frames the core acts on are typed. Frames it only forwards to the UI keep
//! their payload as raw JSON, so the sidecar and the frontend can evolve the
//! event shape without a Rust change in the middle.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/* ------------------------------------------------------------------ */
/* Host -> Sidecar                                                     */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "t")]
pub enum HostFrame {
    #[serde(rename = "start")]
    Start { id: String, cfg: StartConfig },
    #[serde(rename = "send")]
    Send { id: String, text: String },
    #[serde(rename = "interrupt")]
    Interrupt { id: String },
    #[serde(rename = "set_mode")]
    SetMode { id: String, mode: String },
    #[serde(rename = "set_model")]
    SetModel {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    #[serde(rename = "permission_reply")]
    PermissionReply {
        id: String,
        #[serde(rename = "reqId")]
        req_id: String,
        result: PermissionReply,
    },
    #[serde(rename = "ask")]
    Ask {
        id: String,
        #[serde(rename = "reqId")]
        req_id: String,
        what: String,
    },
    #[serde(rename = "close")]
    Close { id: String },
    #[serde(rename = "shutdown")]
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct StartConfig {
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    #[serde(rename = "forkSession", skip_serializing_if = "Option::is_none")]
    pub fork_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(rename = "permissionMode", skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(rename = "claudePath", skip_serializing_if = "Option::is_none")]
    pub claude_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "behavior")]
pub enum PermissionReply {
    #[serde(rename = "allow")]
    Allow {
        #[serde(rename = "updatedInput", skip_serializing_if = "Option::is_none")]
        updated_input: Option<serde_json::Value>,
        #[serde(
            rename = "updatedPermissions",
            skip_serializing_if = "Option::is_none"
        )]
        updated_permissions: Option<serde_json::Value>,
    },
    #[serde(rename = "deny")]
    Deny {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
    },
}

impl PermissionReply {
    pub fn allow() -> Self {
        Self::Allow {
            updated_input: None,
            updated_permissions: None,
        }
    }

    pub fn deny(message: impl Into<String>) -> Self {
        Self::Deny {
            message: message.into(),
            interrupt: None,
        }
    }
}

/* ------------------------------------------------------------------ */
/* Sidecar -> Host                                                     */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t")]
pub enum SidecarFrame {
    #[serde(rename = "ready")]
    Ready { pid: u32 },
    #[serde(rename = "event")]
    Event {
        id: String,
        ev: serde_json::Value,
    },
    #[serde(rename = "permission_request")]
    PermissionRequest {
        id: String,
        #[serde(rename = "reqId")]
        req_id: String,
        req: PermissionRequest,
    },
    #[serde(rename = "permission_settled")]
    PermissionSettled {
        id: String,
        #[serde(rename = "reqId")]
        req_id: String,
    },
    #[serde(rename = "reply")]
    Reply {
        #[serde(rename = "reqId")]
        req_id: String,
        ok: bool,
        #[serde(default)]
        data: serde_json::Value,
        #[serde(default)]
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub input: serde_json::Value,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(default, rename = "decisionReason")]
    pub decision_reason: Option<String>,
    #[serde(default, rename = "blockedPath")]
    pub blocked_path: Option<String>,
    /// Rules to persist when the user picks "always allow". Opaque here —
    /// they are handed straight back to the SDK.
    #[serde(default)]
    pub suggestions: Option<serde_json::Value>,
}

impl PermissionRequest {
    /// The Bash command line, when this is a Bash request. Used by the rule
    /// engine and for the UI's compact one-line summary.
    pub fn bash_command(&self) -> Option<&str> {
        if self.tool_name != "Bash" {
            return None;
        }
        self.input.get("command")?.as_str()
    }
}
