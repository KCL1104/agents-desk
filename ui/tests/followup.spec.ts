import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

const DIFF = [
  'diff --git a/src/auth.py b/src/auth.py',
  '--- a/src/auth.py',
  '+++ b/src/auth.py',
  '@@ -1,3 +1,3 @@',
  ' def login():',
  '-    return None',
  '+    return session',
].join('\n');

async function reviewMidTurn(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.getByTestId('view-board').click();

  await page.getByRole('button', { name: '新增卡片' }).click();
  await page.getByTestId('task-title').fill('修好登入');
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
  await page.locator('[data-testid="task-k1"] button.primary').click();
  await page.getByTestId('attempt-start').click();
  await expect(page.locator('.pane:visible')).toHaveCount(1);

  // Mid-turn: the agent is working while the review is being written.
  await page.evaluate((d) => {
    window.__mock.report('s1', 'running');
    window.__mock.diffs.set('k1-a1', d);
  }, DIFF);
  await page.getByTestId('view-board').click();
  await page.getByTestId('inspect-k1').click();
  await expect(page.getByTestId('diff-body')).toBeVisible();

  await page.locator('.diff-line.add').click();
  await page.getByTestId('review-note').fill('session 可能是 undefined');
  await page.getByTestId('review-add').click();
}

/**
 * VK's queue-a-follow-up, AgentDesk-shaped: mid-turn, the review batch
 * holds for Stop instead of steering the turn it reviews — and arrives as
 * the next one, about a diff that has stopped moving.
 */
test.describe('the queued follow-up', () => {
  test('mid-turn, the batch queues; Stop spends it onto the timeline', async ({ page }) => {
    await reviewMidTurn(page);

    // The button says what will actually happen.
    await expect(page.getByTestId('review-send')).toHaveText(/這輪結束後送出 1 則/);
    await page.getByTestId('review-send').click();

    // Held, visibly, with a way to change your mind.
    await expect(page.getByTestId('queued-followup')).toBeVisible();
    await expect(page.getByTestId('review-pending')).toHaveCount(0);

    // Stop lands: the message goes in and the banner goes with it.
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await expect(page.getByTestId('queued-followup')).toHaveCount(0);
    await page.getByTestId('inspector-timeline-tab').click();
    await expect(page.locator('.tl-row.tl-prompt').last()).toContainText(
      'session 可能是 undefined',
    );
  });

  test('cancelling takes it back before Stop can spend it', async ({ page }) => {
    await reviewMidTurn(page);
    await page.getByTestId('review-send').click();
    await expect(page.getByTestId('queued-followup')).toBeVisible();

    await page.getByTestId('cancel-followup').click();
    await expect(page.getByTestId('queued-followup')).toHaveCount(0);

    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await page.getByTestId('inspector-timeline-tab').click();
    // Only the opening prompt — nothing was sent behind anyone's back.
    await expect(page.locator('.tl-row.tl-prompt')).toHaveCount(1);
  });

  test('an idle session sends now, exactly as before', async ({ page }) => {
    await reviewMidTurn(page);
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await expect(page.getByTestId('review-send')).toHaveText(/把 1 則意見送回給 agent/);
  });
});
