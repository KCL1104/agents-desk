import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

const DIFF = [
  'diff --git a/src/auth.py b/src/auth.py',
  'index 1111111..2222222 100644',
  '--- a/src/auth.py',
  '+++ b/src/auth.py',
  '@@ -1,3 +1,3 @@',
  ' def login():',
  '-    return None',
  '+    return session',
].join('\n');

async function boardWithAttempt(page: Page, agent = 'claude') {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.getByTestId('view-board').click();

  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  await page.getByTestId('task-title').fill('修好登入');
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();

  await page.locator('[data-testid="task-k1"] button.primary').click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  if (agent !== 'claude') {
    await page.getByTestId('attempt-agent').selectOption(agent);
  }
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();

  await page.evaluate((diff) => {
    window.__mock.diffs.set('k1-a1', diff);
  }, DIFF);
  await page.getByTestId('inspect-k1').click();
  await expect(page.getByTestId('diff-body')).toBeVisible();
}

test.describe('the review loop', () => {
  /**
   * The acceptance for M5: read the diff, point at lines, and send the
   * feedback back into the live session — one message, no navigation, and
   * the timeline keeps what was asked.
   */
  test('feedback attaches to lines and goes back as one message', async ({ page }) => {
    await boardWithAttempt(page);

    // Point at the added line and say what is wrong with it.
    await page.locator('.diff-line.add').click();
    await expect(page.getByTestId('review')).toBeVisible();
    await expect(page.getByTestId('review')).toContainText('src/auth.py:2');
    await page.getByTestId('review-note').fill('session 可能是 undefined，要先檢查');
    await page.getByTestId('review-add').click();

    // The line wears its feedback, and the batch shows one entry.
    await expect(page.locator('.diff-line.noted')).toHaveCount(1);
    await expect(page.getByTestId('review-pending').locator('li')).toHaveCount(1);

    // A second point, on the context line.
    await page.locator('.diff-line', { hasText: 'def login():' }).click();
    await page.getByTestId('review-note').fill('這個函式要有 docstring');
    await page.getByTestId('review-add').click();
    await expect(page.getByTestId('review-pending').locator('li')).toHaveCount(2);

    // Send. The batch leaves as ONE message through the session's terminal.
    await page.getByTestId('review-send').click();
    await expect(page.getByTestId('review-pending')).toHaveCount(0);

    const call = await page.evaluate(
      () => window.__mock.calls.find((c) => c.cmd === 'send_followup')?.args,
    );
    const sent = call as { id: string; text: string };
    expect(sent.id).toBe('s1');
    expect(sent.text).toContain('[Marol 檢視回饋]');
    expect(sent.text).toContain('1. src/auth.py:2');
    expect(sent.text).toContain('> +    return session');
    expect(sent.text).toContain('session 可能是 undefined，要先檢查');
    expect(sent.text).toContain('2. src/auth.py:1');
    expect(sent.text).toContain('這個函式要有 docstring');

    // The record: the follow-up sits on the timeline beside the first prompt.
    await page.getByTestId('inspector-timeline-tab').click();
    const rows = page.locator('.tl-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText('session 可能是 undefined');
  });

  /** Headers must not take feedback — a filename names no line. Clicking
   *  one folds the file instead, and the fold is a fold, not a comment. */
  test('file headers fold and hunk markers take nothing', async ({ page }) => {
    await boardWithAttempt(page);
    // The plumbing lines are gone from the render; the file chip carries
    // the name and the counts, with the raw header a hover away.
    await expect(page.locator('.diff-line.meta')).toHaveCount(0);
    await expect(page.locator('.diff-file')).toContainText('src/auth.py');

    await page.getByTestId('diff-fold-0').click();
    await expect(page.locator('.diff-line.hunk')).toHaveCount(0);
    await expect(page.getByTestId('review')).toHaveCount(0);

    await page.getByTestId('diff-fold-0').click();
    await page.locator('.diff-line.hunk').click();
    await expect(page.getByTestId('review')).toHaveCount(0);
  });

  /**
   * The batch survives the drawer. ⌘I unmounts the inspector outright and
   * the drawer follows focus between panes — half-written feedback must
   * ride both out, the same promise the dialogs' dirty-guard makes for a
   * stray backdrop click.
   */
  test('closing the drawer does not destroy the pending batch', async ({ page }) => {
    await boardWithAttempt(page);
    await page.locator('.diff-line.add').click();
    await page.getByTestId('review-note').fill('session 可能是 undefined，要先檢查');
    await page.getByTestId('review-add').click();
    await expect(page.getByTestId('review-pending').locator('li')).toHaveCount(1);

    // Away and back — the drawer unmounts entirely in between.
    await page.getByTestId('toggle-inspector').click();
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await page.getByTestId('toggle-inspector').click();
    await expect(page.getByTestId('review-pending').locator('li')).toHaveCount(1);
    await expect(page.locator('.diff-line.noted')).toHaveCount(1);
  });

  /** A comment added and then thought better of leaves nothing behind. */
  test('feedback can be taken back out of the batch before it is sent', async ({ page }) => {
    await boardWithAttempt(page);
    await page.locator('.diff-line.add').click();
    await page.getByTestId('review-note').fill('算了，沒事');
    await page.getByTestId('review-add').click();

    await page.getByRole('button', { name: '移除這則意見' }).click();
    await expect(page.getByTestId('review')).toHaveCount(0);
    await expect(page.locator('.diff-line.noted')).toHaveCount(0);
  });

  /**
   * The same honesty the first prompt has: an unmeasured CLI is not typed
   * into on a guess. The composed text is offered to copy instead, and the
   * send button simply is not there.
   */
  test('an unmeasured CLI gets the feedback to copy, not a send button', async ({ page }) => {
    await boardWithAttempt(page, 'gemini');

    await page.locator('.diff-line.add').click();
    await page.getByTestId('review-note').fill('這裡要改');
    await page.getByTestId('review-add').click();

    await expect(page.getByTestId('review-send')).toHaveCount(0);
    await page.getByTestId('review-copy').click();
    await expect(page.getByTestId('review-copy')).toHaveText('已複製');
    // Nothing was pushed into the terminal behind the person's back.
    const pushed = await page.evaluate(
      () => window.__mock.calls.filter((c) => c.cmd === 'send_followup').length,
    );
    expect(pushed).toBe(0);
  });
});
