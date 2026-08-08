import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.tab')).toHaveCount(1);
}

async function openTheming(page: Page) {
  await page.locator('.sidebar-foot').click();
  await expect(page.getByTestId('theming')).toBeVisible();
}

test.describe('themes', () => {
  test('a preset repaints the whole app and survives a restart', async ({ page }) => {
    await boot(page);
    await openTheming(page);

    await page.getByTestId('theme-paper').click();
    // Paper is light: the body itself changes ground.
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 246, 244)');

    // The choice is the user's, not the session's.
    await page.reload();
    await expect(page.locator('.tab')).toHaveCount(1);
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(246, 246, 244)');

    // And back: the default preset is today's exact palette.
    await openTheming(page);
    await page.getByTestId('theme-ink').click();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(19, 19, 22)');
  });

  test('custom colors apply live, with the contrast floor shown', async ({ page }) => {
    await boot(page);
    await openTheming(page);

    await page.getByTestId('theme-custom').click();
    await expect(page.getByTestId('theme-editor')).toBeVisible();

    // A new accent lands immediately — on the tokens, so everywhere.
    await page.getByTestId('color-accent').fill('#cc5588');
    const accent = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--accent'),
    );
    expect(accent).toBe('#cc5588');

    // The chips keep the stylesheet's promise honest: sabotage the text
    // color and the floor visibly breaks.
    await expect(page.locator('.contrast-chip.pass')).toHaveCount(4);
    await page.getByTestId('color-fg').fill('#3a3a40');
    await expect(page.locator('.contrast-chip.fail').first()).toBeVisible();
  });

  test('open terminals change clothes with the theme', async ({ page }) => {
    await boot(page);
    // One live session, terminal mounted.
    await page.locator('.sidebar-head button.icon').click();
    await page.locator('.modal input.mono').first().fill('/Users/test/scratch');
    await page.locator('.modal button.primary').click();
    await expect(page.locator('.pane:visible')).toHaveCount(1);

    await openTheming(page);
    await page.getByTestId('theme-pine').click();
    const termBg = await page.evaluate(() => {
      const host = document.querySelector('.term-host') as HTMLDivElement & {
        __term?: { options: { theme?: { background?: string } } };
      };
      return host.__term?.options.theme?.background;
    });
    expect(termBg).toBe('#121614');
  });
});
