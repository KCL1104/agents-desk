import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AttemptEvent,
  BootStatus,
  Lifecycle,
  Outcome,
  SessionMeta,
  Tab,
  Task,
} from './types';

/** What pressing 開始 did. Mirrors core.rs StartResult. */
export interface StartResult {
  /** Set when there was room and it started now. */
  attempt: OpenedAttempt | null;
  /** Set when there was not: where it sits in the queue, counting from 1. */
  queuedAt: number | null;
}

/** What opening an attempt produced. Mirrors core.rs OpenedAttempt. */
export interface OpenedAttempt {
  attempt_id: string;
  session_id: string;
  branch: string;
  worktree_path: string;
  prompt: string;
  /** False for a CLI whose argument conventions we have not measured: the
      session is real, but the first message is yours to deliver. */
  prompt_sent: boolean;
}

export const api = {
  bootStatus: () => invoke<BootStatus>('boot_status'),

  newSession: (cwd: string, agent: string, args: string[], cols: number, rows: number) =>
    invoke<string>('new_session', { cwd, agent, args, cols, rows }),

  reopenSession: (id: string, cols: number, rows: number) =>
    invoke<void>('reopen_session', { id, cols, rows }),

  termWrite: (id: string, data: string) => invoke<void>('term_write', { id, data }),
  termResize: (id: string, cols: number, rows: number) =>
    invoke<void>('term_resize', { id, cols, rows }),

  closeSession: (id: string) => invoke<void>('close_session', { id }),
  archiveSession: (id: string) => invoke<void>('archive_session', { id }),
  setCompleted: (id: string, completed: boolean) =>
    invoke<void>('set_completed', { id, completed }),
  listSessions: () => invoke<SessionMeta[]>('list_sessions'),

  listTabs: () => invoke<Tab[]>('list_tabs'),
  createTab: (name: string) => invoke<string>('create_tab', { name }),
  renameTab: (id: string, name: string) => invoke<void>('rename_tab', { id, name }),
  closeTab: (id: string) => invoke<void>('close_tab', { id }),
  updateTab: (id: string, layout: string, slots: Array<string | null>) =>
    invoke<void>('update_tab', { id, layout, slots }),

  listTasks: () => invoke<Task[]>('list_tasks'),
  createTask: (title: string, prompt: string, repoPath: string, baseBranch: string) =>
    invoke<string>('create_task', { title, prompt, repoPath, baseBranch }),
  /** Move a card between columns, or reorder within one. Only a drag calls this. */
  moveTask: (id: string, lifecycle: Lifecycle, position: number) =>
    invoke<void>('move_task', { id, lifecycle, position }),
  deleteTask: (id: string) => invoke<void>('delete_task', { id }),

  /** The first message as it would be sent, for the dialog to show and edit. */
  previewPrompt: (taskId: string, agent: string) =>
    invoke<{ prompt: string; willSend: boolean }>('preview_prompt', { taskId, agent }),
  openAttempt: (
    taskId: string,
    agent: string,
    prompt: string | null,
    cols: number,
    rows: number,
  ) => invoke<StartResult>('open_attempt', { taskId, agent, prompt, cols, rows }),
  cancelQueued: (taskId: string) => invoke<void>('cancel_queued', { taskId }),

  /** How many attempts may hold a terminal at once. What is being rationed
      is a person's attention, not a machine. */
  concurrency: () =>
    invoke<{ max: number; running: number; queued: number }>('concurrency'),
  setConcurrency: (max: number) => invoke<void>('set_concurrency', { max }),

  /** Fold the attempt's branch back into its base, then close it out. */
  mergeAttempt: (attemptId: string) => invoke<string>('merge_attempt', { attemptId }),
  /** Push and open a pull request. The attempt stays open — review is when
      there is still something to change. */
  openPr: (attemptId: string) => invoke<string>('open_pr', { attemptId }),
  reopenAttempt: (attemptId: string, cols: number, rows: number) =>
    invoke<string>('reopen_attempt', { attemptId, cols, rows }),
  finishAttempt: (attemptId: string, outcome: Outcome) =>
    invoke<void>('finish_attempt', { attemptId, outcome }),
  attemptDiff: (attemptId: string) => invoke<string>('attempt_diff', { attemptId }),
  attemptEvents: (attemptId: string) =>
    invoke<AttemptEvent[]>('attempt_events', { attemptId }),
  /** Send a later message into an attempt's live terminal, as one pasted
      message. Only for CLIs whose input conventions are measured. */
  sendFollowup: (id: string, text: string) =>
    invoke<void>('send_followup', { id, text }),

  /** Replay buffer for a pane mounting after its PTY already started. */
  termSnapshot: (id: string) => invoke<{ data: string; seq: number }>('term_snapshot', { id }),

  /** Subscribe to one session's terminal output. Data is base64 bytes. */
  onTermOutput: (id: string, cb: (data: string, seq: number) => void): Promise<UnlistenFn> =>
    listen<{ id: string; data: string; seq: number }>('term:output', (e) => {
      if (e.payload.id === id) cb(e.payload.data, e.payload.seq);
    }),
};

export interface Handlers {
  onSessions: (s: SessionMeta[]) => void;
  onExit: (id: string, status: string) => void;
  onTabs: (tabs: Tab[]) => void;
  onTasks: (tasks: Task[]) => void;
  onBadge: (count: number) => void;
  onCoreReady: () => void;
  onCoreFailed: (error: string) => void;
}

export async function subscribe(h: Handlers): Promise<UnlistenFn> {
  const offs: UnlistenFn[] = [];
  offs.push(await listen<SessionMeta[]>('sessions:changed', (e) => h.onSessions(e.payload)));
  offs.push(await listen<Task[]>('tasks:changed', (e) => h.onTasks(e.payload)));
  offs.push(
    await listen<{ id: string; status: string }>('term:exit', (e) =>
      h.onExit(e.payload.id, e.payload.status),
    ),
  );
  offs.push(await listen<Tab[]>('tabs:changed', (e) => h.onTabs(e.payload)));
  offs.push(
    await listen<{ count: number }>('badge', (e) => h.onBadge(e.payload.count)),
  );
  offs.push(await listen('core:ready', () => h.onCoreReady()));
  offs.push(await listen<{ error: string }>('core:failed', (e) => h.onCoreFailed(e.payload.error)));
  return () => offs.forEach((off) => off());
}
