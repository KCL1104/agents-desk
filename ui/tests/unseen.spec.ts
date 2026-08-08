import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boardWithAttempt(page: Page) {
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
  await page.getByTestId('attempt-start').click();
  await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
}

/**
 * The third attention tier. 「等你」 already has a whole signal chain; these
 * cover its missing sibling — a turn that ends while its terminal is not the
 * one in front of you stays marked unread until it has been looked at.
 */
test.describe('finished while you were away', () => {
  test('a turn ending off-screen marks the session unread everywhere', async ({ page }) => {
    await boardWithAttempt(page);

    // Working, with the board in front — the terminal is off-screen.
    await page.evaluate(() => window.__mock.report('s1', 'running'));
    await page.getByTestId('view-board').click();
    await page.evaluate(() => window.__mock.report('s1', 'idle'));

    // The sidebar row, the board card, and the tab all say unread.
    await expect(page.getByTestId('unseen-s1')).toBeVisible();
    await expect(page.getByTestId('unseen-card-k1')).toBeVisible();
    await expect(page.locator('.tab-badge.unseen')).toHaveText('1');
  });

  test('looking at the terminal is what clears it', async ({ page }) => {
    await boardWithAttempt(page);
    await page.evaluate(() => window.__mock.report('s1', 'running'));
    await page.getByTestId('view-board').click();
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await expect(page.getByTestId('unseen-s1')).toBeVisible();

    // Walking through the card lands in the TUI — that is the look.
    await page.locator('[data-testid="task-k1"] .card-door').click();
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    await expect(page.getByTestId('unseen-s1')).toHaveCount(0);
    await expect(page.locator('.tab-badge.unseen')).toHaveCount(0);
  });

  test('a turn ending in front of you was never unread', async ({ page }) => {
    await boardWithAttempt(page);
    await page.evaluate(() => window.__mock.report('s1', 'running'));

    // Still in terminal view, caret in this pane: the end is seen live.
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await expect(page.locator('[data-testid="session-s1"] .dot.idle')).toBeVisible();
    await expect(page.getByTestId('unseen-s1')).toHaveCount(0);
  });

  test('running again clears an unread ending', async ({ page }) => {
    await boardWithAttempt(page);
    await page.evaluate(() => window.__mock.report('s1', 'running'));
    await page.getByTestId('view-board').click();
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await expect(page.getByTestId('unseen-card-k1')).toBeVisible();

    // A review batch sent from the drawer starts the next turn without the
    // terminal ever taking focus — the old ending is no longer news.
    await page.evaluate(() => window.__mock.report('s1', 'running'));
    await expect(page.getByTestId('unseen-card-k1')).toHaveCount(0);
  });
});
