/** Mirrors src-tauri/src/core.rs. */

export type Status =
  | 'saved'
  | 'starting'
  /** Sitting on Claude Code's folder-trust prompt, which every new worktree
      opens on. No hook reports this — nothing runs until it is answered — so
      the core sets it directly. See core.rs. */
  | 'awaiting_trust'
  | 'running'
  /** Blocked on a permission decision — cannot continue without you. */
  | 'waiting_permission'
  /** Idle long enough that Claude Code raised an idle prompt. */
  | 'waiting_input'
  /** Finished its turn; your move. */
  | 'idle'
  | 'exited';

/** The states where an agent is actually blocked on a human. */
export const NEEDS_YOU: readonly Status[] = [
  'waiting_permission',
  'waiting_input',
  'awaiting_trust',
];

export function needsYou(s: Status): boolean {
  return NEEDS_YOU.includes(s);
}

/** Where a card sits on the board. Moved by hand, only ever by hand. */
export type Lifecycle = 'backlog' | 'running' | 'review' | 'done' | 'abandoned';

/** How an attempt ended. Setting one removes its worktree. */
export type Outcome = 'merged' | 'discarded' | 'superseded';

/** How much the agent may do without asking, chosen per attempt. The
    worktree is the safety case: the attempt can only spend its own branch. */
export type PermissionMode = 'normal' | 'accept_edits' | 'yolo';

/** Mirrors core.rs AttemptView. */
export interface Attempt {
  id: string;
  task_id: string;
  /** Which try this is, for `<slug>-<n>`. */
  seq: number;
  agent: string;
  worktree_path: string;
  branch: string;
  base_sha: string;
  /** How much the agent may do without asking. Approved at start, kept for
      every resume, worn as a badge while it runs. */
  mode: PermissionMode;
  /** `null` while it is still going. */
  outcome: Outcome | null;
  /** The diff, captured before the worktree was removed. */
  frozen_diff: string | null;
  created_at: number;
  /** `null` once the attempt's session has been archived out from under it. */
  session_id: string | null;
}

/** One moment on an attempt's timeline. Mirrors store.rs AttemptEvent. */
export interface AttemptEvent {
  id: number;
  attempt_id: string;
  at: number;
  /** `prompt` — what it was asked. `tool` — what it reached for.
      `status` — when it started waiting on you, or stopped. */
  kind: 'prompt' | 'tool' | 'status' | string;
  tool: string | null;
  detail: string | null;
}

/** Mirrors core.rs TaskView. */
export interface Task {
  id: string;
  title: string;
  prompt: string;
  repo_path: string;
  base_branch: string;
  lifecycle: Lifecycle;
  position: number;
  created_at: number;
  attempts: Attempt[];
  /** Where this card sits in the start queue, counting from 1, when every
      slot was taken at the moment 開始 was pressed. */
  queued_at: number | null;
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
  /** The attempt this session runs, or `null` for an ad-hoc session that
      lives outside the board. */
  attempt_id: string | null;
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
