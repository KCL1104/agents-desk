import type { MessageKey } from './i18n';

/**
 * One-shot coaching, for the one surprise the screen cannot show.
 *
 * There were five of these. Four taught what the interface was already
 * saying at the moment they fired — what a worktree is (the welcome panel's
 * three lines, read a minute earlier), what a permission mode does (the
 * label on the select just used), that finishing is final (the buttons arm),
 * that an agent is waiting (the sidebar counts it, the card wears it, the
 * pane pulses, the tab badges it). A popup that repeats the screen is the
 * screen admitting it does not trust itself.
 *
 * What is left is the one fact nothing on screen can carry: inside a
 * terminal, Ctrl+letter belongs to the shell, so the app's own chords take
 * Shift. Stored as a seen-map, so adding a mark later never renumbers the
 * ones already answered.
 */
export type CoachId = 'terminal';

export const COACH_KEY: Record<CoachId, { title: MessageKey; body: MessageKey }> = {
  /** The first time the caret lands in a pane: which keys leave it. */
  terminal: { title: 'coach.terminal.title', body: 'coach.terminal.body' },
};

const KEY = 'marol.coach';

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

/**
 * Forget every mark, so the five moments teach again.
 *
 * The welcome panel can already be reopened, but that is the panel, not the
 * walkthrough: the concepts that bite mid-task are taught by these marks, and
 * until now the only way back to them was clearing site data. A tour worth
 * showing once is worth showing again on request — especially now that the
 * interface leans on them instead of repeating itself at every control.
 */
export function clearCoachSeen(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored means nothing to forget */
  }
}
