/** Mirrors src-tauri/src/core.rs. */

export type Status =
  | 'saved'
  | 'starting'
  | 'running'
  /** Blocked on a permission decision — cannot continue without you. */
  | 'waiting_permission'
  /** Idle long enough that Claude Code raised an idle prompt. */
  | 'waiting_input'
  /** Finished its turn; your move. */
  | 'idle'
  | 'exited';

/** The states where an agent is actually blocked on a human. */
export const NEEDS_YOU: readonly Status[] = ['waiting_permission', 'waiting_input'];

export function needsYou(s: Status): boolean {
  return NEEDS_YOU.includes(s);
}

export interface SessionMeta {
  id: string;
  cwd: string;
  title: string;
  /** Which agent CLI this session runs: `claude`, `codex`, ... */
  agent: string;
  status: Status;
  created_at: number;
  last_active_at: number;
  live: boolean;
  /** What the agent is doing right now, from its last PreToolUse report. */
  activity: { tool: string; detail: string } | null;
  /** When that activity started, for the elapsed counter. */
  activity_since: number;
  /** Marked done by the user. Never inferred — `Stop` means the turn ended,
      not that the work is finished. */
  completed: boolean;
  /** True once the status plugin has reported, so the UI can tell "idle" from
      "this CLI does not report status". */
  reports_status: boolean;
}

export interface BootStatus {
  ready: boolean;
  error?: string | null;
  shell?: string;
  envResolved?: boolean;
  envVarCount?: number;
  path?: string | null;
  claude?: string | null;
  db?: string;
  hookUrl?: string | null;
}

/** A named working arrangement. Mirrors src-tauri/src/store.rs StoredTab. */
export interface Tab {
  id: string;
  name: string;
  layout: string;
  slots: Array<string | null>;
  position: number;
}
