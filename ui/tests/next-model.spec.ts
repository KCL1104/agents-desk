import { test, expect } from '@playwright/test';
import { nextAction } from '../src/next';
import { autoCollapse, COLLAPSE_OVER } from '../src/review';
import type { AttemptStat } from '../src/api';

function stat(over: Partial<AttemptStat> = {}): AttemptStat {
  return { files: 1, adds: 10, dels: 2, ahead: 0, behind: 0, dirty: false, ...over };
}

/**
 * The suggestion is the merge path's own checks, surfaced early — so each
 * verdict here mirrors a refusal or a risk the merge would meet later.
 */
test.describe('the next action', () => {
  test('uncommitted work outranks everything', async () => {
    // A merge now would silently miss the changes — the worst outcome the
    // finish path guards against, so it speaks first.
    expect(nextAction(stat({ dirty: true, ahead: 3, behind: 2 }))).toBe('commit');
  });

  test('a base that moved under a branch that also moved says rebase', async () => {
    expect(nextAction(stat({ ahead: 2, behind: 1 }))).toBe('rebase');
  });

  test('clean and ahead is ready', async () => {
    expect(nextAction(stat({ ahead: 1 }))).toBe('finish');
  });

  test('nothing to merge is nothing to say', async () => {
    expect(nextAction(stat())).toBe(null);
    // Behind with nothing of its own: rebasing empty work helps nobody.
    expect(nextAction(stat({ behind: 4 }))).toBe(null);
  });
});

test.describe('the fold policy', () => {
  test('walls and deletions start folded; ordinary files stay open', async () => {
    expect(autoCollapse(COLLAPSE_OVER + 1, [])).toBe(true);
    expect(autoCollapse(12, ['deleted file mode 100644'])).toBe(true);
    expect(autoCollapse(COLLAPSE_OVER, [])).toBe(false);
    expect(autoCollapse(12, ['new file mode 100644'])).toBe(false);
  });
});
