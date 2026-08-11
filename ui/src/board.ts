import type { MessageKey, TFn } from './i18n';
import type { Attempt, Lifecycle, SessionMeta, Status, Task } from './types';
import { STATUS_KEY } from './sections';

export { STATUS_KEY };

/** Left to right. `abandoned` has no column — a card there is off the board. */
export const COLUMNS: readonly Lifecycle[] = ['backlog', 'running', 'review', 'done'];

export const COLUMN_KEY: Record<Lifecycle, MessageKey> = {
  backlog: 'lifecycle.backlog',
  running: 'lifecycle.running',
  review: 'lifecycle.review',
  done: 'lifecycle.done',
  abandoned: 'lifecycle.abandoned',
};

export const OUTCOME_KEY: Record<string, MessageKey> = {
  merged: 'outcome.merged',
  discarded: 'outcome.discarded',
  superseded: 'outcome.superseded',
};

/** The mime type a dragged card carries, kept apart from the pane layout's. */
export const TASK_MIME = 'application/x-marol-task';

/**
 * The second axis, as one value the card can render.
 *
 * Deliberately separate from the card's column. A card in `running` whose
 * agent has stopped is a real and common state — it is what every attempt
 * looks like after a restart, since the app kills its PTYs on the way out —
 * and the board has to say so rather than implying the agent is still going.
 */
export type Live =
  /** No attempt has been made at this card yet. */
  | { kind: 'none' }
  /** Approved, but every slot was taken. It will go on its own. */
  | { kind: 'queued'; position: number }
  /** An attempt is running, and this is what its session reports. */
  | { kind: 'session'; status: Status; session: SessionMeta; attempt: Attempt }
  /** An attempt exists but nothing is running it. Resumable. */
  | { kind: 'stopped'; attempt: Attempt }
  /** Running, with nothing attached to it here: tmux kept the agent through
      a restart. Opening the card reconnects to what is already going, so it
      must not read as 未執行 — that is the same lie the status label used to
      tell, told again in the one place people look first. */
  | { kind: 'detached'; session: SessionMeta; attempt: Attempt }
  /** Parked: worktree and slot given back, branch and conversation kept.
      Quieter than stopped — it is asleep on purpose. */
  | { kind: 'parked'; attempt: Attempt }
  /** Its outcome is set, so its worktree is gone. Read-only from here. */
  | { kind: 'finished'; attempt: Attempt };

/**
 * The attempt a card is *about* right now: the newest one still open, or
 * failing that the newest one at all.
 *
 * Newest rather than first, because opening a second attempt is how you
 * switch agent, and the card should follow the one you just started.
 */
export function currentAttempt(task: Task): Attempt | null {
  if (task.attempts.length === 0) return null;
  const open = task.attempts.filter((a) => a.outcome === null);
  const pool = open.length > 0 ? open : task.attempts;
  return pool.reduce((best, a) => (a.seq > best.seq ? a : best));
}

export function liveStateOf(task: Task, sessions: readonly SessionMeta[]): Live {
  const attempt = currentAttempt(task);
  // A card waiting for a slot has no attempt yet — the worktree is not made
  // until its turn comes. Tested for a number rather than against null, so a
  // payload that simply omits the field reads as "not queued" rather than as
  // "queued at position undefined".
  if (!attempt && typeof task.queued_at === 'number') {
    return { kind: 'queued', position: task.queued_at };
  }
  if (!attempt) return { kind: 'none' };
  if (attempt.outcome !== null) return { kind: 'finished', attempt };
  // Tested for a number, like queued_at above: a payload that omits the
  // field reads as "not parked", never as parked-at-undefined.
  if (typeof attempt.parked_at === 'number') return { kind: 'parked', attempt };

  const session = attempt.session_id
    ? sessions.find((s) => s.id === attempt.session_id)
    : undefined;
  // A session that is not live has no terminal attached; `saved` and `exited`
  // both mean the same thing to the board, which is that pressing resume is
  // what happens next.
  if (session && !session.live && session.status === 'detached') {
    return { kind: 'detached', session, attempt };
  }
  if (!session || !session.live) return { kind: 'stopped', attempt };
  return { kind: 'session', status: session.status, session, attempt };
}

/** What the card's light says.
 *
 *  `withMode` 讓卡片的 aria-label 把權限模式一起唸出來：⚡ 徽章只是
 *  圖示，對螢幕閱讀器是沉默的，而「這個 session 少問你」正是最不該
 *  無聲的狀態。畫面上的狀態行不帶它 —— 徽章已經站在那裡了。 */
export function liveLabel(live: Live, t: TFn, withMode = false): string {
  switch (live.kind) {
    case 'none':
      return t('live.notStarted');
    case 'queued':
      return t('live.queued', { position: live.position });
    case 'stopped':
      return t('live.stopped');
    case 'detached':
      return t('status.detached');
    case 'parked':
      return t('live.parked');
    case 'finished': {
      const key = OUTCOME_KEY[live.attempt.outcome ?? ''];
      return key ? t(key) : t('live.ended');
    }
    case 'session': {
      const label = t(STATUS_KEY[live.status]);
      const mode = live.attempt.mode;
      // 逐字比對而非 !== 'normal'：舊資料可能沒有 mode 欄位，undefined
      // 不該被當成一種要朗讀的模式。
      if (withMode && (mode === 'yolo' || mode === 'accept_edits')) {
        return `${label}${t('common.sep')}${t(mode === 'yolo' ? 'mode.yolo' : 'mode.accept_edits')}`;
      }
      return label;
    }
  }
}

/**
 * The class the card's dot takes. `stopped` and `none` share the neutral one
 * so a card that is merely idle never looks like a warning.
 */
export function liveTone(live: Live): string {
  switch (live.kind) {
    case 'session':
      return live.status;
    case 'finished':
      return 'exited';
    // Its own tone rather than falling through to `saved`: the dot is
    // deliberately the neutral one — the agent is running but its hooks
    // still answer to the port the previous app instance held, so nothing
    // here knows what it is doing until the session is opened.
    case 'detached':
      return 'detached';
    default:
      return 'saved';
  }
}

/**
 * Where a card should land, given the card it was dropped on.
 *
 * Dropping onto a card inserts before it; dropping onto the column's empty
 * space appends. Positions are recomputed from scratch on the Rust side, so
 * this only has to name an index in the destination column.
 */
export function dropIndex(
  column: readonly Task[],
  draggedId: string,
  overId: string | null,
): number {
  const without = column.filter((t) => t.id !== draggedId);
  if (overId === null) return without.length;
  const at = without.findIndex((t) => t.id === overId);
  return at < 0 ? without.length : at;
}

/**
 * The name a card wears for its repository.
 *
 * Cards from different repositories share one board — that is the point of a
 * desk — so each has to say which codebase it is about. The basename is
 * enough to tell repos apart; the full path is a tooltip away.
 */
export function repoName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * The badge a card wears when its repository lives in another world:
 * `wsl://Ubuntu/home/me/app` → `wsl:Ubuntu`, `ssh://devbox/...` →
 * `ssh:devbox`. Local paths wear none. Mirrors host.rs `label`.
 */
export function hostLabel(path: string): string | null {
  const m = /^(wsl|ssh):\/\/([^/]+)\//.exec(path);
  return m ? `${m[1]}:${m[2]}` : null;
}

/** Cards of one column, in their stored order. */
export function columnOf(tasks: readonly Task[], lifecycle: Lifecycle): Task[] {
  return tasks
    .filter((t) => t.lifecycle === lifecycle)
    .slice()
    .sort((a, b) => a.position - b.position);
}
