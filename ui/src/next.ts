import type { AttemptStat } from './api';
import type { MessageKey } from './i18n';

/**
 * The one state-appropriate next step for an open attempt, read off git.
 *
 * Conductor's best idea, taken without its transcript: because every
 * signal here is git-side — uncommitted paths, commits either side of the
 * base — the suggestion never has to interpret the agent, and it turns N
 * parallel terminals into a queue of decisions. Each value is exactly one
 * of the merge path's own checks, surfaced before the click instead of
 * refusing after it:
 *
 *   `commit` — uncommitted work; a merge now would not include it.
 *   `rebase` — the base has moved on under a branch that also moved;
 *              mergeable, but every commit it is behind is conflict risk
 *              taken blind.
 *   `finish` — clean and ahead: the merge or the PR is ready to go.
 *   `null`   — nothing to say: no commits yet, nothing pending.
 */
export type NextAction = 'commit' | 'rebase' | 'finish' | null;

export function nextAction(stat: AttemptStat): NextAction {
  if (stat.dirty) return 'commit';
  if (stat.ahead > 0 && stat.behind > 0) return 'rebase';
  if (stat.ahead > 0) return 'finish';
  return null;
}

/** What each suggestion says, wherever it is worn — card and drawer alike,
 *  so the two surfaces can never phrase one state two ways. */
export const NEXT_KEY: Record<Exclude<NextAction, null>, MessageKey> = {
  commit: 'next.commit',
  rebase: 'next.rebase',
  finish: 'next.finish',
};
