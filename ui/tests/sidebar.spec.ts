import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

/** Matches SETTLE_MS in src/sections.ts. */
const SETTLE_MS = 2500;

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

/** Which section a session's row is currently rendered under. */
async function sectionOf(page: Page, id: string): Promise<string | null> {
  return page
    .locator(`[data-testid="session-${id}"]`)
    .evaluate((el) => el.closest('.section')?.getAttribute('data-section') ?? null);
}

const report = (page: Page, id: string, status: string, activity?: unknown) =>
  page.evaluate(
    ([i, st, act]) => window.__mock.report(i as string, st as string, act as any),
    [id, status, activity] as const,
  );

test.describe('sidebar sections', () => {
  test('sessions land in the section their status implies', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');

    await report(page, 's1', 'running');
    expect(await sectionOf(page, 's1')).toBe('working');

    // s2 is selected, so s1 is unpinned: being blocked on a permission
    // decision must not wait out the settle window.
    await report(page, 's1', 'waiting_permission');
    await expect.poll(() => sectionOf(page, 's1')).toBe('waiting');
  });

  test('the pin holds even for a permission prompt on the session you are watching', async ({
    page,
  }) => {
    await page.clock.install();
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await report(page, 's1', 'running');
    expect(await sectionOf(page, 's1')).toBe('working');

    // The prompt is already on screen in the terminal you are looking at, and
    // the waiting banner still counts it — moving the row would be noise.
    await report(page, 's1', 'waiting_permission');
    await page.clock.fastForward(SETTLE_MS * 3);
    expect(await sectionOf(page, 's1')).toBe('working');
    await expect(page.locator('.waiting-banner')).toContainText('1 個等你');
  });

  test('an end-of-turn blip does not move the row', async ({ page }) => {
    await page.clock.install();
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');

    // s2 is selected (newest), so s1 is the unpinned one to observe.
    await report(page, 's1', 'running');
    await expect.poll(() => sectionOf(page, 's1')).toBe('working');

    // `Stop` fires at the end of every turn. A session that is about to keep
    // working must not visibly hop to 等待輸入 and back.
    await report(page, 's1', 'idle');
    await page.clock.fastForward(SETTLE_MS - 500);
    expect(await sectionOf(page, 's1')).toBe('working');

    await report(page, 's1', 'running');
    await page.clock.fastForward(SETTLE_MS * 2);
    expect(await sectionOf(page, 's1')).toBe('working');
  });

  test('a session that really has settled does move', async ({ page }) => {
    await page.clock.install();
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');

    await report(page, 's1', 'running');
    await expect.poll(() => sectionOf(page, 's1')).toBe('working');

    await report(page, 's1', 'idle');
    await page.clock.fastForward(SETTLE_MS + 500);
    await expect.poll(() => sectionOf(page, 's1')).toBe('waiting');
  });

  test('the selected session is pinned so the row never moves under the cursor', async ({
    page,
  }) => {
    await page.clock.install();
    await boot(page);
    await newSession(page, '/Users/test/repo-one');

    await report(page, 's1', 'running');
    await expect.poll(() => sectionOf(page, 's1')).toBe('working');

    // s1 is the selected session. Even a long settle must not move it.
    await report(page, 's1', 'idle');
    await page.clock.fastForward(SETTLE_MS * 4);
    expect(await sectionOf(page, 's1')).toBe('working');
  });

  test('marking a session done files it under 已完成 at once, even when pinned', async ({
    page,
  }) => {
    await page.clock.install();
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    expect(await sectionOf(page, 's1')).toBe('working');

    // s1 is the selected session, so the pin would normally hold it in place.
    // An explicit action must override that without waiting.
    await page.locator('[data-testid="session-s1"] .row-action').first().click();
    await expect(page.locator('[data-section="done"]')).toBeVisible();

    // 已完成 starts collapsed, so the row is filed there but out of the way.
    await page.locator('[data-section="done"] .section-head').click();
    await expect.poll(() => sectionOf(page, 's1')).toBe('done');
  });

  test('the row shows what the agent is doing, not just that it is busy', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');

    await report(page, 's1', 'running', { tool: 'Bash', detail: 'pytest tests/test_auth.py -v' });

    const row = page.locator('[data-testid="session-s1"]');
    await expect(row.locator('.row-tool')).toHaveText('Bash');
    await expect(row.locator('.row-detail')).toHaveText('pytest tests/test_auth.py -v');
  });
});
