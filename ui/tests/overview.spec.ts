import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  // The arrangement lives on a tab, so nothing renders until one exists.
  await expect(page.locator('.tab')).toHaveCount(1);
}

async function newSession(page: Page, cwd: string) {
  await page.locator('.sidebar-head button.icon').click();
  await page.locator('.modal input.mono').first().fill(cwd);
  await page.locator('.modal button.primary').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

const report = (page: Page, id: string, status: string, activity?: unknown) =>
  page.evaluate(
    ([i, st, act]) => window.__mock.report(i as string, st as string, act as any),
    [id, status, activity] as const,
  );

const toOverview = (page: Page) =>
  page.locator('.view-toggle button', { hasText: '總覽' }).click();

test.describe('overview', () => {
  test('shows every session with what it is doing', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');

    await report(page, 's1', 'running', { tool: 'Bash', detail: 'pytest tests/ -v' });
    await report(page, 's2', 'waiting_permission', { tool: 'Bash', detail: 'rm -rf build/' });

    await toOverview(page);
    await expect(page.locator('.ov-card')).toHaveCount(2);

    const one = page.locator('[data-testid="card-s1"]');
    await expect(one.locator('.row-tool')).toHaveText('Bash');
    await expect(one.locator('.ov-detail')).toHaveText('pytest tests/ -v');
    await expect(one.locator('.ov-status')).toHaveText('執行中');

    // A blocked session must be findable without reading every card.
    const two = page.locator('[data-testid="card-s2"]');
    await expect(two).toHaveClass(/waiting_permission/);
    await expect(two.locator('.ov-status')).toHaveText('等你授權');
  });

  test('cards are grouped the same way the sidebar is', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await report(page, 's1', 'running');
    await report(page, 's2', 'idle');

    await toOverview(page);
    // Two views of the same data must not disagree about where a session is.
    // A turn that ended is 待命, not 等你: nothing is blocked on a human.
    await expect(page.locator('[data-ov-section="working"] .ov-card')).toHaveCount(1);
    await expect(page.locator('[data-ov-section="idle"] .ov-card')).toHaveCount(1);
    await expect(page.locator('[data-ov-section="waiting"]')).toHaveCount(0);
  });

  test('sessions from another world get separators — an all-local desk gets none', async ({
    page,
  }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await toOverview(page);

    // One world: a header saying the one obvious thing would be noise.
    await expect(page.locator('.ov-card')).toHaveCount(2);
    await expect(page.locator('.ov-world')).toHaveCount(0);

    // A WSL session appears: now "which machine" is a real question, and
    // every group answers it — including the local one, by name.
    await page.locator('.view-toggle button', { hasText: '終端機' }).click();
    await newSession(page, 'wsl://Ubuntu/home/me/app');
    await toOverview(page);

    await expect(page.getByTestId('world-local')).toHaveText('本機');
    await expect(page.getByTestId('world-wsl:Ubuntu')).toHaveText('wsl:Ubuntu');
  });

  test('opening a card goes to that session’s terminal', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await toOverview(page);

    await page.locator('[data-testid="card-s1"] button.primary').click();

    await expect(page.locator('.overview')).toHaveCount(0);
    await expect(page.locator('.topbar strong')).toHaveText('repo-one');
    // Focus lands on the card you opened rather than staying where it was.
    await expect(page.locator('.pane[data-session-id="s1"]')).toHaveClass(/focused/);
  });

  test('terminals survive a trip through the overview', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await expect(page.locator('.pane')).toHaveCount(1);

    const before = await page
      .locator('.term-host')
      .first()
      .evaluate((el) => (el as HTMLElement & { __term?: any }).__term?.buffer.active.length);

    await toOverview(page);
    // Unmounting would dispose the terminal and lose its scrollback.
    await expect(page.locator('.pane')).toHaveCount(1);
    await page.locator('.view-toggle button', { hasText: '終端機' }).click();

    const after = await page
      .locator('.term-host')
      .first()
      .evaluate((el) => (el as HTMLElement & { __term?: any }).__term?.buffer.active.length);
    expect(after).toBe(before);
  });

  test('a session with no status reporting says so rather than looking idle', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await toOverview(page);

    // codex and friends have no hook mechanism; an empty activity line would
    // read as "doing nothing" instead of "cannot tell".
    await expect(page.locator('[data-testid="card-s1"] .ov-activity')).toContainText(
      '不回報狀態',
    );
  });

  test('the chosen view is remembered across a reload', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await toOverview(page);
    await expect(page.locator('.overview')).toBeVisible();

    await page.reload();
    await expect(page.locator('.overview')).toBeVisible();
  });
});
