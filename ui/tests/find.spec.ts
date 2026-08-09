import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
}

async function newSession(page: Page, cwd: string) {
  await page.locator('.sidebar-head button.icon').click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.locator('.modal input.mono').first().fill(cwd);
  await page.locator('.modal button.primary').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

/** Feed plain lines into a session's terminal, as the PTY would. */
async function feed(page: Page, id: string, text: string) {
  await page.evaluate(
    ([sid, b64]) => window.__mock.feed(sid, b64, 1),
    [id, Buffer.from(text).toString('base64')],
  );
}

test.describe('find in terminal', () => {
  /**
   * The scale story's search half: 10k lines of scrollback are a wall
   * without a way to search them. ⌘F opens the bar; from inside a
   * terminal the chord adds Shift, the same shell rule every letter
   * chord follows (Ctrl+F belongs to readline in there).
   */
  test('finds a needle in the scrollback and selects it', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await feed(page, 's1', 'plain line\r\nthe needle sits here\r\nanother line\r\n');

    await page.locator('.pane .term-host').click();
    await page.keyboard.press('Control+Shift+F');
    const input = page.getByTestId('term-find-input-s1');
    await expect(input).toBeFocused();

    await input.fill('needle');
    await input.press('Enter');
    const selected = await page
      .locator('.pane .term-host')
      .evaluate((el) => (el as HTMLElement & { __term?: any }).__term?.getSelection());
    expect(selected).toBe('needle');
  });

  test('a search with no hit says so instead of shrugging', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await feed(page, 's1', 'nothing to see\r\n');

    await page.locator('.pane .term-host').click();
    await page.keyboard.press('Control+Shift+F');
    const input = page.getByTestId('term-find-input-s1');
    await input.fill('unicorn');
    await input.press('Enter');
    await expect(input).toHaveClass(/no-match/);
    // Typing again clears the verdict — it described the last search,
    // not this one.
    await input.fill('unicor');
    await expect(input).not.toHaveClass(/no-match/);
  });

  test('escape closes the bar and hands the caret back to the terminal', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');

    await page.locator('.pane .term-host').click();
    await page.keyboard.press('Control+Shift+F');
    await expect(page.getByTestId('term-find-s1')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('term-find-s1')).toHaveCount(0);
    // The terminal owns the keys again.
    const focusInTerm = await page.evaluate(() => {
      const host = document.querySelector('.pane .term-host');
      return host !== null && host.contains(document.activeElement);
    });
    expect(focusInTerm).toBe(true);
  });
});
