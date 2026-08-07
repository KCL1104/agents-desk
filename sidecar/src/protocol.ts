/**
 * NDJSON wire protocol between the Rust host and this Node sidecar.
 *
 * One JSON object per line. stdout carries protocol frames only; all
 * diagnostics go to stderr so a stray log can never corrupt the stream.
 */

import type { PermissionMode, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';

/* ------------------------------------------------------------------ */
/* Host -> Sidecar                                                     */
/* ------------------------------------------------------------------ */

export type HostFrame =
  | { t: 'start'; id: string; cfg: StartConfig }
  | { t: 'send'; id: string; text: string }
  | { t: 'interrupt'; id: string }
  | { t: 'set_mode'; id: string; mode: PermissionMode }
  | { t: 'set_model'; id: string; model?: string }
  | { t: 'permission_reply'; id: string; reqId: string; result: PermissionReply }
  | { t: 'ask'; id: string; reqId: string; what: AskKind }
  | { t: 'close'; id: string }
  | { t: 'shutdown' };

/** Introspection the UI can pull on demand. */
export type AskKind = 'context' | 'mcp_status' | 'commands' | 'models';

export interface StartConfig {
  /** Working directory. Decides which CLAUDE.md, .claude/ and .mcp.json load. */
  cwd: string;
  /** First user turn. Omit to open an idle session. */
  prompt?: string;
  /** Prior SDK session id to continue. */
  resume?: string;
  /** Continue `resume` as a new branch instead of extending it. */
  forkSession?: boolean;
  model?: string;
  permissionMode?: PermissionMode;
  /**
   * Full environment for the agent process, resolved by the host from a
   * login shell. Without this a GUI-launched app hands the agent a stub
   * PATH and every npx-based MCP server fails to start.
   */
  env?: Record<string, string>;
  /** Explicit `claude` binary path, when the host found one off PATH. */
  claudePath?: string;
}

export type PermissionReply =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/* ------------------------------------------------------------------ */
/* Sidecar -> Host                                                     */
/* ------------------------------------------------------------------ */

export type SidecarFrame =
  | { t: 'event'; id: string; ev: AgentEvent }
  | { t: 'permission_request'; id: string; reqId: string; req: PermissionRequest }
  | { t: 'permission_settled'; id: string; reqId: string }
  | { t: 'reply'; reqId: string; ok: true; data: unknown }
  | { t: 'reply'; reqId: string; ok: false; error: string }
  | { t: 'ready'; pid: number };

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  /** Prompt sentence rendered by the SDK, e.g. "Claude wants to read foo.txt". */
  title?: string;
  /** Short noun phrase for a button label, e.g. "Read file". */
  displayName?: string;
  /** Why the request fired at all. */
  decisionReason?: string;
  /** Path that tripped a directory boundary, when applicable. */
  blockedPath?: string;
  /**
   * Rules to persist if the user picks "always allow". Hand these straight
   * back as `updatedPermissions`.
   */
  suggestions?: PermissionUpdate[];
}

/**
 * Normalized event stream. Every executor (Agent SDK today, other agent
 * CLIs later) emits this shape so one UI renders all of them.
 */
export type AgentEvent =
  | {
      kind: 'init';
      sessionId: string;
      model: string;
      cwd: string;
      permissionMode: string;
      tools: string[];
      /** Terminal-parity evidence: what actually loaded for this session. */
      mcpServers: Array<{ name: string; status: string }>;
      slashCommands: string[];
      skills: string[];
      plugins: unknown[];
      pluginErrors: unknown[];
      mcpServerErrors: unknown[];
    }
  | { kind: 'text_delta'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; toolUseId: string; name: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; content: unknown; isError: boolean }
  | { kind: 'turn_end' }
  | {
      kind: 'done';
      subtype: string;
      isError: boolean;
      costUsd?: number;
      durationMs?: number;
      numTurns?: number;
      result?: string;
      sessionId?: string;
    }
  | { kind: 'error'; message: string }
  | { kind: 'closed' };
