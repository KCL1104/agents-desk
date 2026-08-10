import type { MessageKey } from './i18n';

/**
 * One-shot coaching, delivered at the moment a concept first bites.
 *
 * The app's sharpest first-touch surprises are all documented — in the
 * README. A person mid-task does not have the README open; they have the
 * screen. So each of these five moments teaches itself exactly once, at
 * the moment it first happens, and never again: the same contract as
 * Claude Squad's `help_screens_seen` bitmask, stored as a seen-map so
 * adding a mark later never renumbers the ones already answered.
 */
export type CoachId = 'attempt' | 'mode' | 'finish' | 'terminal' | 'waiting';

export const COACH_KEY: Record<CoachId, { title: MessageKey; body: MessageKey }> = {
  /** The first Start: what a worktree is, and why the trust prompt comes. */
  attempt: { title: 'coach.attempt.title', body: 'coach.attempt.body' },
  /** The first ⚡/✎ launch: what running with fewer prompts means. */
  mode: { title: 'coach.mode.title', body: 'coach.mode.body' },
  /** The first sight of the Finish footer: an outcome is final. */
  finish: { title: 'coach.finish.title', body: 'coach.finish.body' },
  /** The first time the caret lands in a pane: which keys leave it. */
  terminal: { title: 'coach.terminal.title', body: 'coach.terminal.body' },
  /** 第一次有 session 從「在做」轉進「等你」:琥珀色的呼吸是什麼、
   *  ⌘/Ctrl+E 跳過去、問題在 pane 裡回答。 */
  waiting: { title: 'coach.waiting.title', body: 'coach.waiting.body' },
};

const KEY = 'agentdesk.coach';

function seenMap(): Partial<Record<CoachId, boolean>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<
      Record<CoachId, boolean>
    >;
  } catch {
    // A corrupt value reads as nothing seen; the worst outcome is being
    // taught again, which beats never being taught.
    return {};
  }
}

export function coachSeen(id: CoachId): boolean {
  return seenMap()[id] === true;
}

export function markCoachSeen(id: CoachId): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...seenMap(), [id]: true }));
  } catch {
    /* without storage the mark just shows again next run */
  }
}
