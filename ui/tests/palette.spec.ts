import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
}

async function newCard(page: Page, title: string) {
  await page.getByRole('button', { name: '新增卡片' }).click();
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
}

async function startFirstAttempt(page: Page, taskId: string) {
  await page.locator(`[data-testid="task-${taskId}"] button.primary`).click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  await page.getByTestId('attempt-start').click();
  await expect(page.locator('.pane:visible')).toHaveCount(1);
}

/**
 * ⌘/Ctrl+K: one keystroke answering both "what needs me" and "take me to
 * X". The first group is the attention inbox, standing before a letter is
 * typed — the reflex under interruption is ⌘K, Enter.
 */
test.describe('the command palette', () => {
  test('a blocked session stands first, and Enter jumps to it', async ({ page }) => {
    await boot(page);
    await page.getByTestId('view-board').click();
    await newCard(page, '修好登入');
    await startFirstAttempt(page, 'k1');
    await page.evaluate(() => window.__mock.report('s1', 'waiting_permission'));
    await page.getByTestId('view-board').click();

    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByTestId('palette')).toBeVisible();
    // First group, first row, already selected: Enter is the whole trip.
    const row = page.getByTestId('pal-session-s1');
    await expect(row).toContainText('修好登入');
    await expect(row).toContainText('等你授權');
    await expect(row).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('palette')).toHaveCount(0);
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane:visible')).toHaveCount(1);
  });

  test('a turn finished behind your back files under its own group', async ({ page }) => {
    await boot(page);
    await page.getByTestId('view-board').click();
    await newCard(page, '修好登入');
    await startFirstAttempt(page, 'k1');
    await page.evaluate(() => window.__mock.report('s1', 'running'));
    await page.getByTestId('view-board').click();
    await page.evaluate(() => window.__mock.report('s1', 'idle'));

    await page.keyboard.press('ControlOrMeta+K');
    const list = page.getByTestId('palette');
    await expect(list).toContainText('完成未看');
    await expect(page.getByTestId('pal-session-s1')).toBeVisible();
  });

  test('navigation appears with a query, and a card with no terminal opens the board', async ({
    page,
  }) => {
    await boot(page);
    await page.getByTestId('view-board').click();
    await newCard(page, '修好登入');
    await newCard(page, '加上深色主題');
    await page.getByRole('tab', { name: '終端機' }).click();

    await page.keyboard.press('ControlOrMeta+K');
    // No query: no card directory — the palette is an inbox, not a list.
    await expect(page.getByTestId('pal-task-k2')).toHaveCount(0);

    await page.getByTestId('palette-input').fill('深色');
    await expect(page.getByTestId('pal-task-k2')).toBeVisible();
    await expect(page.getByTestId('pal-task-k1')).toHaveCount(0);

    await page.getByTestId('pal-task-k2').click();
    await expect(page.getByTestId('palette')).toHaveCount(0);
    await expect(page.getByTestId('board')).toBeVisible();
  });

  test('actions come from the registry and land where their buttons would', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByTestId('palette')).toBeVisible();

    await page.getByTestId('pal-action-new-card').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('task-title')).toBeVisible();
  });

  test('arrows walk the rows and Escape closes without a trace', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('ControlOrMeta+K');

    // Only the action group exists on an empty desk; arrows move within it.
    const first = page.locator('.palette-item').first();
    const second = page.locator('.palette-item').nth(1);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(first).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('ArrowUp');
    await expect(first).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toHaveCount(0);
  });

  test('the filter reaches the actions too', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('ControlOrMeta+K');
    await page.getByTestId('palette-input').fill('快捷');
    await expect(page.getByTestId('pal-action-open-keys')).toBeVisible();
    await expect(page.getByTestId('pal-action-new-card')).toHaveCount(0);

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('shortcuts')).toBeVisible();
  });
});
