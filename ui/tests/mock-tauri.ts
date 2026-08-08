/**
 * A stand-in for the Tauri IPC bridge, injected before the app's modules load.
 *
 * macOS ships WKWebView with no WebDriver endpoint, so the packaged window
 * cannot be driven directly. Running the same React tree in Chromium against
 * this mock still exercises everything above the IPC boundary — the session
 * list, the new-session flow, and xterm's decoding and rendering of real PTY
 * bytes — which is where both reported bugs live.
 */

export interface MockSession {
  id: string;
  cwd: string;
  title: string;
  agent: string;
  status: string;
  created_at: number;
  last_active_at: number;
  live: boolean;
  reports_status: boolean;
  activity: { tool: string; detail: string } | null;
  activity_since: number;
  completed: boolean;
  attempt_id: string | null;
}

export interface MockAttempt {
  id: string;
  task_id: string;
  seq: number;
  agent: string;
  worktree_path: string;
  branch: string;
  base_sha: string;
  mode: string;
  outcome: string | null;
  frozen_diff: string | null;
  created_at: number;
  session_id: string | null;
}

export interface MockEvent {
  id: number;
  attempt_id: string;
  at: number;
  kind: string;
  tool: string | null;
  detail: string | null;
}

export interface MockTask {
  id: string;
  title: string;
  prompt: string;
  repo_path: string;
  base_branch: string;
  lifecycle: string;
  position: number;
  created_at: number;
  attempts: MockAttempt[];
  queued_at: number | null;
}

export interface MockTab {
  id: string;
  name: string;
  layout: string;
  slots: Array<string | null>;
  position: number;
}

declare global {
  interface Window {
    __mock: {
      sessions: MockSession[];
      tabs: MockTab[];
      tasks: MockTask[];
      /** Which repositories exist, and what branches they have. The core
          refuses a card it cannot open a worktree for, so the mock must too. */
      repos: Record<string, string[]>;
      /** What each attempt's worktree currently shows as changed. */
      diffs: Map<string, string>;
      events: Map<string, MockEvent[]>;
      /** Cards waiting for a slot, in order. */
      queue: string[];
      pendingStarts: Map<string, { agent: string; prompt: string; mode: string }>;
      /** Attempts whose worktree has uncommitted work, so merge must refuse. */
      dirtyWorktrees: Set<string>;
      /** The repo's `.agentdesk/config.json` run script names. */
      runScripts: string[];
      /** Named launch profiles, as the settings table holds them. */
      profiles: Array<{ name: string; agent: string; args: string[] }>;
      maxConcurrent: number;
      /** How many attempts hold a terminal right now. */
      running(): number;
      drainQueue(): void;
      /** Stand in for a hook landing on an attempt's timeline. */
      record(attemptId: string, kind: string, tool: string | null, detail: string | null): void;
      persist(): void;
      pushSessions(): void;
      pushTasks(): void;
      sorted(): MockSession[];
      calls: Array<{ cmd: string; args: unknown }>;
      listeners: Map<string, number[]>;
      cbSeq: number;
      snapshots: Map<string, { data: string; seq: number }>;
      emit(event: string, payload: unknown): void;
      /** Push a base64 chunk to a session's terminal, as the PTY would. */
      feed(id: string, data: string, seq: number): void;
      /** Stand in for a hook report: change status and optionally activity. */
      report(id: string, status: string, activity?: { tool: string; detail: string }): void;
    };
  }
}

/**
 * Runs inside the page before any app code. Kept as one self-contained
 * function so Playwright can pass it straight to `addInitScript`.
 */
export function installMock(): void {
  // Pin the language. Without this the suite would render in whatever locale
  // the CI browser happens to report, and every assertion below that names a
  // button would pass or fail by accident. The switcher itself is covered in
  // i18n.spec.ts, which overrides this deliberately.
  try {
    // Only when nothing has been chosen: this script re-runs on every load,
    // including reloads, so setting it unconditionally would overwrite a
    // language the test just switched to and make persistence untestable.
    if (localStorage.getItem('agentdesk.locale') === null) {
      localStorage.setItem('agentdesk.locale', 'zh-TW');
    }
  } catch {
    /* storage unavailable; detection falls back to the browser locale */
  }

  const mock = {
    sessions: JSON.parse(
      sessionStorage.getItem('__mockSessions') ?? '[]',
    ) as MockSession[],
    tabs: JSON.parse(
      sessionStorage.getItem('__mockTabs') ??
        '[{"id":"t1","name":"工作區","layout":"{\\"mode\\":\\"auto\\",\\"cols\\":\\"auto\\"}","slots":[],"position":0}]',
    ) as MockTab[],
    tasks: JSON.parse(sessionStorage.getItem('__mockTasks') ?? '[]') as MockTask[],
    repos: { '/Users/test/picked-repo': ['main', 'develop'] } as Record<string, string[]>,
    diffs: new Map<string, string>(),
    events: new Map<string, MockEvent[]>(),
    queue: [] as string[],
    maxConcurrent: 3,
    pendingStarts: new Map<string, { agent: string; prompt: string; mode: string }>(),
    dirtyWorktrees: new Set<string>(),
    runScripts: [] as string[],
    profiles: [] as Array<{ name: string; agent: string; args: string[] }>,
    calls: [] as Array<{ cmd: string; args: unknown }>,
    listeners: new Map<string, number[]>(),
    cbSeq: 0,
    snapshots: new Map<string, { data: string; seq: number }>(),

    /** The core sorts by last activity, newest first. */
    sorted() {
      return [...mock.sessions].sort((a, b) => b.last_active_at - a.last_active_at);
    },

    emit(event: string, payload: unknown) {
      // Deep-copy the way Tauri's IPC does. Emitting a live reference would
      // let React's identity check skip work that the real app always does,
      // and the mock would report bugs the product does not have.
      const frozen = JSON.parse(JSON.stringify(payload)) as unknown;
      for (const id of mock.listeners.get(event) ?? []) {
        const cb = (window as unknown as Record<string, unknown>)[`_${id}`];
        if (typeof cb === 'function') {
          (cb as (m: unknown) => void)({ event, id: 0, payload: frozen });
        }
      }
    },

    /**
     * Stand in for the core surviving a reload.
     *
     * Reloading the webview does not restart the Rust side, so the sessions
     * are still running and still live when the page comes back. Dropping
     * them here instead would empty every tab on reload and make the layout
     * look as though it had not been saved.
     */
    persist() {
      sessionStorage.setItem('__mockTabs', JSON.stringify(mock.tabs));
      sessionStorage.setItem('__mockSessions', JSON.stringify(mock.sessions));
      sessionStorage.setItem('__mockTasks', JSON.stringify(mock.tasks));
    },

    /** Save, then broadcast — the order the real core writes and emits in. */
    pushSessions() {
      mock.persist();
      queueMicrotask(() => mock.emit('sessions:changed', mock.sorted()));
    },

    pushTasks() {
      // The core recomputes each card's queue position on every broadcast.
      for (const t of mock.tasks) {
        const at = mock.queue.indexOf(t.id);
        t.queued_at = at < 0 ? null : at + 1;
      }
      mock.persist();
      queueMicrotask(() => mock.emit('tasks:changed', mock.tasks));
    },

    feed(id: string, data: string, seq: number) {
      mock.emit('term:output', { id, data, seq });
    },

    report(id: string, status: string, activity?: { tool: string; detail: string }) {
      const s = mock.sessions.find((x) => x.id === id);
      if (!s) return;
      s.status = status;
      s.reports_status = true;
      if (activity) {
        s.activity = activity;
        s.activity_since = Date.now();
      }
      mock.emit('sessions:changed', mock.sorted());
    },

    record(attemptId: string, kind: string, tool: string | null, detail: string | null) {
      const rows = mock.events.get(attemptId) ?? [];
      rows.push({
        id: rows.length + 1,
        attempt_id: attemptId,
        at: Date.now(),
        kind,
        tool,
        detail,
      });
      mock.events.set(attemptId, rows);
    },

    running() {
      return mock.sessions.filter((s) => s.live && s.attempt_id !== null).length;
    },

    /** Start whatever the freed slots can take, as the core does. */
    drainQueue() {
      while (mock.queue.length > 0 && mock.running() < mock.maxConcurrent) {
        const taskId = mock.queue.shift()!;
        const pending = mock.pendingStarts.get(taskId);
        mock.pendingStarts.delete(taskId);
        if (pending) startAttempt(taskId, pending.agent, pending.prompt, pending.mode);
      }
    },

    /** The core renumbers both affected columns on every move. */
    renumber() {
      for (const life of ['backlog', 'running', 'review', 'done', 'abandoned']) {
        mock.tasks
          .filter((t) => t.lifecycle === life)
          .sort((a, b) => a.position - b.position)
          .forEach((t, i) => {
            t.position = i;
          });
      }
    },
  };

  window.__mock = mock;

  const now = () => Date.now();

  /** A profile name resolves to its CLI; anything else is a binary name —
      the core's own semantics. */
  const resolveAgent = (name: string) =>
    mock.profiles.find((p) => p.name === name)?.agent ?? name;

  const makeSession = (cwd: string, agent: string): MockSession => {
    const id = `s${mock.sessions.length + 1}`;
    return {
      id,
      cwd,
      title: cwd.split('/').filter(Boolean).pop() ?? cwd,
      agent,
      status: 'starting',
      created_at: now(),
      last_active_at: now(),
      live: true,
      reports_status: false,
      activity: null,
      activity_since: 0,
      completed: false,
      attempt_id: null,
    };
  };

  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    boot_status: () => ({
      ready: true,
      shell: '/bin/zsh',
      envResolved: true,
      envVarCount: 42,
      path: '/usr/local/bin:/usr/bin:/bin',
      claude: '/usr/local/bin/claude',
      db: '/tmp/agentdesk.db',
      hookUrl: 'http://127.0.0.1:1/h/tok',
    }),

    list_sessions: () => mock.sorted(),

    list_tabs: () => mock.tabs,

    create_tab: (args) => {
      const id = `t${mock.tabs.length + 1}`;
      mock.tabs.push({
        id,
        name: String(args.name),
        layout: '{"mode":"auto","cols":"auto"}',
        slots: [],
        position: mock.tabs.length,
      });
      mock.persist();
      queueMicrotask(() => mock.emit('tabs:changed', mock.tabs));
      return id;
    },

    rename_tab: (args) => {
      const t = mock.tabs.find((x) => x.id === args.id);
      if (t) t.name = String(args.name);
      mock.persist();
      queueMicrotask(() => mock.emit('tabs:changed', mock.tabs));
      return null;
    },

    close_tab: (args) => {
      if (mock.tabs.length <= 1) throw new Error('the last tab cannot be closed');
      mock.tabs = mock.tabs.filter((x) => x.id !== args.id);
      mock.persist();
      queueMicrotask(() => mock.emit('tabs:changed', mock.tabs));
      return null;
    },

    update_tab: (args) => {
      const slots = args.slots as Array<string | null>;
      // The core enforces one-session-per-tab; the mock must too, or the
      // frontend would be tested against rules the real app does not have.
      const claimed = new Set(slots.filter((s): s is string => s !== null));
      for (const t of mock.tabs) {
        if (t.id === args.id) {
          t.layout = String(args.layout);
          t.slots = slots;
        } else {
          // The core closes the gap rather than blanking a position, because
          // a blank one cannot be told apart from one emptied on purpose.
          t.slots = t.slots.filter((s) => s === null || !claimed.has(s));
        }
      }
      mock.persist();
      queueMicrotask(() => mock.emit('tabs:changed', mock.tabs));
      return null;
    },

    new_session: (args) => {
      const s = makeSession(String(args.cwd), resolveAgent(String(args.agent ?? 'claude')));
      mock.sessions.push(s);
      if (!mock.snapshots.has(s.id)) mock.snapshots.set(s.id, { data: '', seq: 0 });
      // The real core broadcasts the new list; the pane mounts on the render
      // that follows.
      mock.pushSessions();
      return s.id;
    },

    reopen_session: (args) => {
      const s = mock.sessions.find((x) => x.id === args.id);
      if (s) {
        s.live = true;
        s.status = 'starting';
      }
      mock.pushSessions();
      return null;
    },

    close_session: (args) => {
      const s = mock.sessions.find((x) => x.id === args.id);
      if (s) {
        s.live = false;
        s.status = 'saved';
      }
      mock.pushSessions();
      // An attempt's terminal ending is the commonest way a slot frees.
      if (s?.attempt_id) {
        mock.drainQueue();
        mock.pushTasks();
      }
      return null;
    },

    archive_session: (args) => {
      mock.sessions = mock.sessions.filter((x) => x.id !== args.id);
      mock.pushSessions();
      return null;
    },

    set_completed: (args) => {
      const s = mock.sessions.find((x) => x.id === args.id);
      if (s) s.completed = Boolean(args.completed);
      mock.pushSessions();
      return null;
    },

    set_locale: () => null,

    term_snapshot: (args) => mock.snapshots.get(String(args.id)) ?? { data: '', seq: 0 },
    term_write: () => null,
    term_resize: () => null,

    /* ---------------------------- board ---------------------------- */

    list_tasks: () => mock.tasks,

    create_task: (args) => {
      const repo = String(args.repoPath);
      const branch = String(args.baseBranch);
      // The core checks both when the card is made, not when it is first run,
      // so a card that could never produce an attempt cannot be created.
      const branches = mock.repos[repo];
      if (!branches) throw new Error(`${repo} is not a git repository`);
      if (!branches.includes(branch)) throw new Error(`${repo} has no branch \`${branch}\``);

      const id = `k${mock.tasks.length + 1}`;
      mock.tasks.push({
        id,
        title: String(args.title),
        prompt: String(args.prompt),
        repo_path: repo,
        base_branch: branch,
        lifecycle: 'backlog',
        position: mock.tasks.filter((t) => t.lifecycle === 'backlog').length,
        created_at: now(),
        attempts: [],
        queued_at: null,
      });
      mock.pushTasks();
      return id;
    },

    move_task: (args) => {
      const t = mock.tasks.find((x) => x.id === args.id);
      if (!t) throw new Error(`no such task: ${String(args.id)}`);
      const to = String(args.lifecycle);
      const at = Number(args.position);
      const column = mock.tasks
        .filter((x) => x.lifecycle === to && x.id !== t.id)
        .sort((a, b) => a.position - b.position);
      t.lifecycle = to;
      // Insert at `at`, then renumber both columns from scratch — exactly what
      // the core does, because a position only means anything relative to its
      // neighbours.
      column.splice(Math.max(0, Math.min(at, column.length)), 0, t);
      column.forEach((x, i) => {
        x.position = i;
      });
      mock.renumber();
      mock.pushTasks();
      return null;
    },

    delete_task: (args) => {
      const t = mock.tasks.find((x) => x.id === args.id);
      // Attempts still holding a worktree give it back with the card.
      const ids = new Set((t?.attempts ?? []).map((a) => a.session_id));
      mock.sessions = mock.sessions.filter((s) => !ids.has(s.id));
      mock.tasks = mock.tasks.filter((x) => x.id !== args.id);
      mock.renumber();
      mock.pushSessions();
      mock.pushTasks();
      return null;
    },

    preview_prompt: (args) => {
      const t = mock.tasks.find((x) => x.id === args.taskId);
      const seq = (t?.attempts.length ?? 0) + 1;
      return {
        prompt:
          `[AgentDesk 任務] ${t?.title ?? ''}\n\n` +
          `你在一個專為這張卡開的 git worktree：分支 agentdesk/card-${seq}，` +
          `從 ${t?.base_branch ?? 'main'} @ abcd1234 開出。\n\n---\n\n${t?.prompt ?? ''}\n`,
        // Only Claude Code's argument conventions have been measured. A
        // profile resolves to the CLI underneath before the question is
        // asked.
        willSend: resolveAgent(String(args.agent)) === 'claude',
      };
    },

    open_attempt: (args) => {
      const taskId = String(args.taskId);
      const t = mock.tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`no such task: ${taskId}`);
      const agent = String(args.agent ?? 'claude');
      const prompt = String(args.prompt ?? '');
      const mode = String(args.mode ?? 'normal');
      // Over the limit it waits its turn rather than being refused.
      if (mock.running() >= mock.maxConcurrent) {
        if (!mock.queue.includes(taskId)) mock.queue.push(taskId);
        mock.pendingStarts.set(taskId, { agent, prompt, mode });
        mock.pushTasks();
        return { attempt: null, queuedAt: mock.queue.indexOf(taskId) + 1 };
      }
      return { attempt: startAttempt(taskId, agent, prompt, mode), queuedAt: null };
    },

    cancel_queued: (args) => {
      const taskId = String(args.taskId);
      mock.queue = mock.queue.filter((x) => x !== taskId);
      mock.pendingStarts.delete(taskId);
      mock.pushTasks();
      return null;
    },

    concurrency: () => ({
      max: mock.maxConcurrent,
      running: mock.running(),
      queued: mock.queue.length,
    }),

    set_concurrency: (args) => {
      mock.maxConcurrent = Math.max(1, Number(args.max));
      // Raising the limit is a way of saying "go now".
      mock.drainQueue();
      mock.pushTasks();
      return null;
    },

    merge_attempt: (args) => {
      const attempt = mock.tasks
        .flatMap((x) => x.attempts)
        .find((a) => a.id === args.attemptId);
      if (!attempt) throw new Error(`no such attempt: ${String(args.attemptId)}`);
      // The core refuses rather than producing a merge without the work in it.
      if (mock.dirtyWorktrees.has(attempt.id)) {
        throw new Error(`${attempt.branch} 還有沒有 commit 的變更，合併不會包含它們。`);
      }
      finishAttempt(attempt.id, 'merged');
      return 'deadbeefcafe';
    },

    open_pr: (args) => {
      const attempt = mock.tasks
        .flatMap((x) => x.attempts)
        .find((a) => a.id === args.attemptId);
      if (!attempt) throw new Error(`no such attempt: ${String(args.attemptId)}`);
      if (mock.dirtyWorktrees.has(attempt.id)) {
        throw new Error(`${attempt.branch} 還有沒有 commit 的變更，推上去不會包含它們。`);
      }
      // The attempt deliberately stays open: review is when there is still
      // something to change.
      return `https://github.com/test/repo/pull/${attempt.seq}`;
    },
  };

  /** Open an attempt now. Shared by the button and the queue, as in the core.
      The launcher name resolves here — a queued start carries the name. */
  function startAttempt(taskId: string, launcher: string, prompt: string, mode = 'normal') {
      const agent = resolveAgent(launcher);
      const t = mock.tasks.find((x) => x.id === taskId)!;
      const seq = t.attempts.length + 1;
      const attemptId = `${t.id}-a${seq}`;
      const session = makeSession(`/Users/test/worktrees/card-${seq}`, agent);
      session.title = `${t.title} #${seq}`;
      session.attempt_id = attemptId;
      // A brand-new worktree always opens on the folder-trust prompt, and no
      // hook reports it — the core sets this directly.
      session.status = agent === 'claude' ? 'awaiting_trust' : 'starting';
      mock.sessions.push(session);
      mock.snapshots.set(session.id, { data: '', seq: 0 });

      t.attempts.push({
        id: attemptId,
        task_id: t.id,
        seq,
        agent,
        worktree_path: session.cwd,
        branch: `agentdesk/card-${seq}`,
        base_sha: 'abcd1234deadbeef',
        mode,
        outcome: null,
        frozen_diff: null,
        created_at: now(),
        session_id: session.id,
      });
      t.lifecycle = 'running';
      // The core writes the prompt as sent onto the timeline.
      mock.record(attemptId, 'prompt', null, prompt);
      mock.renumber();
      mock.pushSessions();
      mock.pushTasks();
      return {
        attempt_id: attemptId,
        session_id: session.id,
        branch: `agentdesk/card-${seq}`,
        worktree_path: session.cwd,
        prompt,
        prompt_sent: agent === 'claude',
      };
  }

  function finishAttempt(attemptId: string, outcome: string) {
    const attempt = mock.tasks.flatMap((x) => x.attempts).find((a) => a.id === attemptId);
    if (!attempt) return;
    attempt.outcome = outcome;
    attempt.frozen_diff =
      mock.diffs.get(attemptId) ?? 'diff --git a/app.txt b/app.txt\n+fixed\n';
    // The worktree goes, and the session with it — which frees a slot.
    mock.sessions = mock.sessions.filter((s) => s.id !== attempt.session_id);
    attempt.session_id = null;
    mock.drainQueue();
    mock.pushSessions();
    mock.pushTasks();
  }

  const rest: Record<string, (args: Record<string, unknown>) => unknown> = {

    reopen_attempt: (args) => {
      const attempt = mock.tasks
        .flatMap((t) => t.attempts)
        .find((a) => a.id === args.attemptId);
      if (!attempt) throw new Error(`no such attempt: ${String(args.attemptId)}`);
      if (attempt.outcome !== null) throw new Error('attempt is finished');
      const s = mock.sessions.find((x) => x.id === attempt.session_id);
      if (s) {
        s.live = true;
        s.status = 'starting';
      }
      mock.pushSessions();
      mock.pushTasks();
      return attempt.session_id;
    },

    finish_attempt: (args) => {
      finishAttempt(String(args.attemptId), String(args.outcome));
      return null;
    },

    attempt_diff: (args) => {
      const attempt = mock.tasks
        .flatMap((t) => t.attempts)
        .find((a) => a.id === args.attemptId);
      // A finished attempt reads the copy frozen before its worktree went.
      if (attempt?.frozen_diff) return attempt.frozen_diff;
      return mock.diffs.get(String(args.attemptId)) ?? '';
    },

    attempt_events: (args) => mock.events.get(String(args.attemptId)) ?? [],

    list_launchers: () =>
      [
        ...['claude', 'codex', 'gemini', 'aider'].map((a) => ({
          name: a,
          agent: a,
          profile: false,
        })),
        ...mock.profiles.map((p) => ({ name: p.name, agent: p.agent, profile: true })),
      ],

    list_profiles: () => mock.profiles,

    save_profiles: (args) => {
      const profiles = args.profiles as Array<{ name: string; agent: string; args: string[] }>;
      // The core's validation, mirrored: every name says something, no two
      // say the same thing, none shadows an agent's own name.
      const seen = new Set<string>();
      for (const p of profiles) {
        if (p.name.trim() === '') throw new Error('a profile needs a name');
        if (['claude', 'codex', 'gemini', 'aider'].includes(p.name.trim())) {
          throw new Error(`\`${p.name}\` is an agent's own name; a profile may not shadow it`);
        }
        if (seen.has(p.name.trim())) throw new Error(`two profiles are both called \`${p.name}\``);
        seen.add(p.name.trim());
      }
      mock.profiles = profiles;
      return null;
    },

    list_run_scripts: () => mock.runScripts,

    run_script: (args) => {
      const attempt = mock.tasks
        .flatMap((t) => t.attempts)
        .find((a) => a.id === args.attemptId);
      if (!attempt) throw new Error(`no such attempt: ${String(args.attemptId)}`);
      if (attempt.outcome !== null) throw new Error('attempt is finished');
      const name = String(args.name);
      if (!mock.runScripts.includes(name)) throw new Error(`no run script named \`${name}\``);
      // An ad-hoc session in the attempt's worktree, exactly as the core
      // makes it: no card, no slot.
      const s = makeSession(attempt.worktree_path, 'sh');
      s.title = `▶ ${name}`;
      mock.sessions.push(s);
      mock.snapshots.set(s.id, { data: '', seq: 0 });
      mock.pushSessions();
      return s.id;
    },

    send_followup: (args) => {
      const s = mock.sessions.find((x) => x.id === args.id);
      if (!s) throw new Error(`no such session: ${String(args.id)}`);
      // The core only sends into CLIs whose input conventions are measured,
      // and only through a live terminal — the mock must refuse the same way.
      if (s.agent !== 'claude') {
        throw new Error(`\`${s.agent}\`'s input conventions have not been measured`);
      }
      if (!s.live) throw new Error(`no terminal for session ${s.id}`);
      if (s.attempt_id) mock.record(s.attempt_id, 'prompt', null, String(args.text));
      return null;
    },

    'plugin:event|listen': (args) => {
      const event = String(args.event);
      const handler = Number(args.handler);
      const ids = mock.listeners.get(event) ?? [];
      ids.push(handler);
      mock.listeners.set(event, ids);
      return handler;
    },
    'plugin:event|unlisten': () => null,
    'plugin:dialog|open': () => '/Users/test/picked-repo',
    'plugin:notification|is_permission_granted': () => true,
    'plugin:notification|notify': () => null,
  };
  Object.assign(handlers, rest);

  // Tauri's unlisten path goes through this, not through invoke. Without it
  // every effect cleanup throws and the noise buries real failures.
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, id: number) => {
      const ids = (mock.listeners.get(event) ?? []).filter((x) => x !== id);
      mock.listeners.set(event, ids);
      return Promise.resolve();
    },
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Record<string, unknown> = {}) => {
      mock.calls.push({ cmd, args });
      const fn = handlers[cmd];
      if (!fn) return Promise.reject(new Error(`unmocked command: ${cmd}`));
      return Promise.resolve(fn(args));
    },
    transformCallback: (cb: unknown) => {
      const id = ++mock.cbSeq;
      (window as unknown as Record<string, unknown>)[`_${id}`] = cb;
      return id;
    },
    metadata: {
      currentWindow: { label: 'main' },
      currentWebview: { label: 'main', windowLabel: 'main' },
    },
  };
}
