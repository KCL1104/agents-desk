import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AttemptEvent,
  BootStatus,
  Launcher,
  Lifecycle,
  NotifyPrefs,
  Outcome,
  PermissionMode,
  Profile,
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

/** An attempt's footprint at a glance. Mirrors worktree.rs DiffStat. */
/** One instruction file an agent working in a directory will read. `exists`
 *  is the honest half: a missing rules file is still worth naming, because
 *  the question people have is "where does this go". */
export interface AgentDoc {
  scope: 'global' | 'project';
  /** `claude` · `codex` · `gemini`, or `shared` for the file all of them
   *  have agreed to look at. */
  agent: string;
  kind: 'rules' | 'skill';
  name: string;
  path: string;
  exists: boolean;
}

export interface AttemptStat {
  /** Files touched, counting untracked ones — an agent's commonest act. */
  files: number;
  adds: number;
  dels: number;
  /** Commits this branch has that the base does not. */
  ahead: number;
  /** Commits the base has grown since — the merge refusal you have not
      hit yet. */
  behind: number;
  /** Uncommitted work in the worktree — the other refusal not yet hit. */
  dirty: boolean;
}

/** One numbered snapshot of an attempt's worktree. Mirrors worktree.rs
    Checkpoint. */
export interface Checkpoint {
  /** Ordinal within the attempt, starting at 1 — base_sha is the free
      zeroth. */
  n: number;
  sha: string;
  /** Unix seconds. */
  at: number;
}

/** What a resume did. Mirrors core.rs Resumed: `restore_error` set means
    the worktree is back but the shelf did not come down cleanly. */
export interface Resumed {
  session_id: string;
  restore_error: string | null;
}

/** What a restore did. Mirrors core.rs Restored. */
export interface Restored {
  /** The checkpoint the worktree now matches — 0 is the attempt's base. */
  to_n: number;
  to_sha: string;
  /** The automatic "now" checkpoint kept first; null when nothing had
      changed since the last one. */
  saved: Checkpoint | null;
}

/** Both sides of one file in an attempt's diff, as full text. Mirrors
    core.rs AttemptFile: `base` null for a file the attempt created, `work`
    null for one it deleted. */
export interface AttemptFile {
  base: string | null;
  work: string | null;
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
    mode: PermissionMode,
    cols: number,
    rows: number,
  ) => invoke<StartResult>('open_attempt', { taskId, agent, prompt, mode, cols, rows }),
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
  /** The attempt's diff — against its base, or against checkpoint n. */
  attemptDiff: (attemptId: string, n?: number) =>
    invoke<string>('attempt_diff', { attemptId, n }),
  /** Line counts and ahead/behind for an open attempt — numstat, never the
      rendered diff, so a board full of cards can afford to ask. */
  attemptStats: (attemptId: string) => invoke<AttemptStat>('attempt_stats', { attemptId }),
  attemptEvents: (attemptId: string) =>
    invoke<AttemptEvent[]>('attempt_events', { attemptId }),
  /** Send a later message into an attempt's live terminal, as one pasted
      message. Only for CLIs whose input conventions are measured. */
  sendFollowup: (id: string, text: string) =>
    invoke<void>('send_followup', { id, text }),
  /** Hold a message for the end of this turn — sent when Stop lands.
      One slot per session; queueing again replaces it. */
  queueFollowup: (id: string, text: string) =>
    invoke<void>('queue_followup', { id, text }),
  cancelFollowup: (id: string) => invoke<void>('cancel_followup', { id }),

  /** The repository's branches, recency first, for the base picker. */
  listBranches: (repoPath: string) => invoke<string[]>('list_branches', { repoPath }),

  /** Park: keep the branch, the checkpoints and the conversation; give
      back the worktree and the slot. Returns the branch, for the clipboard. */
  parkAttempt: (attemptId: string) => invoke<string>('park_attempt', { attemptId }),
  /** Resume a parked attempt: worktree back at its old path, shelf
      restored, terminal reopened on the old conversation. */
  resumeAttempt: (attemptId: string, cols: number, rows: number) =>
    invoke<Resumed>('resume_attempt', { attemptId, cols, rows }),

  /** Whether the end of a turn snapshots the worktree. */
  checkpointsEnabled: () => invoke<boolean>('checkpoints_enabled'),
  setCheckpointsEnabled: (on: boolean) => invoke<void>('set_checkpoints_enabled', { on }),
  /** The manual snapshot. Null when nothing changed since the last one. */
  checkpointNow: (attemptId: string) =>
    invoke<Checkpoint | null>('checkpoint_now', { attemptId }),
  listCheckpoints: (attemptId: string) =>
    invoke<Checkpoint[]>('list_checkpoints', { attemptId }),
  /** Put the worktree back to checkpoint n (0 = the attempt's base). Code
      only; refused while a turn is in flight. */
  restoreCheckpoint: (attemptId: string, n: number) =>
    invoke<Restored>('restore_checkpoint', { attemptId, n }),

  /** Which notifications the desk raises, chosen in the environment panel. */
  notifyPrefs: () => invoke<NotifyPrefs>('notify_prefs'),
  setNotifyPrefs: (prefs: NotifyPrefs) => invoke<void>('set_notify_prefs', { prefs }),
  /** Fire one now — the only honest way to check the channel reaches the OS. */
  testNotification: () => invoke<void>('test_notification'),

  /** Everything a launch dialog can offer: bare agents, then profiles. */
  listLaunchers: () => invoke<Launcher[]>('list_launchers'),
  listProfiles: () => invoke<Profile[]>('list_profiles'),
  /** Replace the profiles wholesale; the backend validates the set. */
  saveProfiles: (profiles: Profile[]) => invoke<void>('save_profiles', { profiles }),

  /** The repository's run scripts (`.agentdesk/config.json`), by name. */
  listRunScripts: (attemptId: string) =>
    invoke<string[]>('list_run_scripts', { attemptId }),
  /** Start a run script in the attempt's worktree, in a terminal of its own.
      Returns the new session's id. */
  runScript: (attemptId: string, name: string, cols: number, rows: number) =>
    invoke<string>('run_script', { attemptId, name, cols, rows }),
  /** A shell of your own in the attempt's worktree. One per attempt:
      asking again while it lives returns the same session. */
  openShell: (attemptId: string, cols: number, rows: number) =>
    invoke<string>('open_shell', { attemptId, cols, rows }),

  /** Whether anything answers on localhost at this port — the difference
      between "the dev server is up" and a blank iframe. */
  probePort: (port: number) => invoke<boolean>('probe_port', { port }),

  /** The worlds a card can live in: WSL distros from `wsl -l`, SSH
      aliases from ~/.ssh/config. Enumerated, never invented; local reads
      only — a dead remote cannot slow this down. */
  listWorlds: () => invoke<{ wsl: string[]; ssh: string[] }>('list_worlds'),
  /** Reach one world (''=local, 'wsl://X', 'ssh://Y'): its claude's
      version, null when the CLI is absent there, or the whole reason the
      world could not be reached. Lazy by design — a person's pick, never
      startup. */
  probeWorld: (world: string) =>
    invoke<{ claude: string | null; error: string | null }>('probe_world', { world }),

  /** One diff file as full text, both sides — what the in-place editor
      edits, where a patch string could only be read. */
  attemptFile: (attemptId: string, path: string) =>
    invoke<AttemptFile>('attempt_file', { attemptId, path }),
  /** Write one worktree file — a human's own edit. The core re-verifies
      settled; the UI hiding the button is not the guard. `expected` is
      the text the editor loaded — a disk that disagrees refuses the save
      rather than letting last-write-wins erase someone else's work. */
  writeAttemptFile: (attemptId: string, path: string, contents: string, expected?: string) =>
    invoke<void>('write_attempt_file', { attemptId, path, contents, expected }),

  /** Open a URL in the system browser. Through the opener plugin, because a
      plain anchor inside the webview would navigate the app itself. */
  openExternal: (url: string) => invoke<void>('plugin:opener|open_url', { url, with: null }),

  /** The rules and skills an agent working in `cwd` will read — every
      supported CLI's convention, present or not. */
  agentDocs: (cwd: string) => invoke<AgentDoc[]>('agent_docs', { cwd }),

  /** Open a local file in whatever the system opens it with. Separate from
      `openExternal` because a Windows path is not a URL — `C:\…` through the
      URL door either fails or means something else entirely. */
  openPath: (path: string) => invoke<void>('plugin:opener|open_path', { path, with: null }),

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
