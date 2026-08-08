import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.getByTestId('view-board').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function newCard(page: Page, title: string) {
  await page.getByRole('button', { name: '新增卡片' }).click();
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
}

async function start(page: Page, taskId: string) {
  await page.locator(`[data-testid="task-${taskId}"] button.primary`).click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  await page.getByTestId('attempt-start').click();
}

/**
 * Claude Squad's per-instance terminal, GUI-shaped: reviewing an agent's
 * work keeps demanding ad-hoc commands in *its* worktree — a shell of your
 * own, one click away, never typed into the agent's terminal.
 */
test.describe('the worktree shell', () => {
  test('the drawer offers a shell, and it opens in the worktree', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();

    await page.getByTestId('open-shell').click();
    // Lands in the shell's own terminal, named for the card it serves.
    await expect(page.locator('.pane[data-session-id="s2"]')).toBeVisible();
    await expect(page.locator('.pane[data-session-id="s2"] .pane-title')).toContainText(
      '$ 修好登入 #1',
    );
    // Ad-hoc, like the ▶ scripts: the card stays about the agent.
    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('adhoc-s2')).toBeVisible();
  });

  test('asking twice returns the shell already there', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await page.getByTestId('open-shell').click();
    await expect(page.locator('.pane[data-session-id="s2"]')).toBeVisible();

    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await page.getByTestId('open-shell').click();
    await expect(page.locator('.pane[data-session-id="s2"]')).toBeVisible();
    // One shell per attempt — no s3 appeared.
    const count = await page.evaluate(() => window.__mock.sessions.length);
    expect(count).toBe(2);
  });
});

/**
 * Claude Squad's list+preview, GUI-shaped: the hovered card's real pane —
 * the same mounted terminal, the same bytes — beside the board, so triage
 * never has to jump in just to look.
 */
test.describe('the board peek', () => {
  test('entering the board keeps the focused session in sight', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();

    await page.getByTestId('view-board').click();
    await expect(page.locator('.term-area.as-preview')).toBeVisible();
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
  });

  test('pointing at another card moves the peek', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await newCard(page, '加上深色主題');
    await start(page, 'k1');
    await page.getByTestId('view-board').click();
    await start(page, 'k2');
    await page.getByTestId('view-board').click();

    await page.getByTestId('task-k1').hover();
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    await expect(page.locator('.pane[data-session-id="s2"]')).toBeHidden();

    await page.getByTestId('task-k2').hover();
    await expect(page.locator('.pane[data-session-id="s2"]')).toBeVisible();
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeHidden();
  });

  test('a board with nothing live has no peek to show', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await expect(page.locator('.term-area.as-preview')).toHaveCount(0);
    await expect(page.locator('.term-area')).toBeHidden();
  });

  test('the door still enters; the peek never replaces it', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.getByTestId('view-board').click();

    await page.locator('[data-testid="task-k1"] .card-door').click();
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane:visible')).toHaveCount(1);
  });
});
