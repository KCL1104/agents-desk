import { test, expect } from '@playwright/test';
import { installMock } from './mock-tauri';

test.describe('cross-session messaging surfaces', () => {
  /** The environment panel answers "can my sessions message each other"
      without the person opening a terminal to find out. */
  test('the environment panel says whether messaging is available', async ({ page }) => {
    await page.addInitScript(installMock);
    await page.goto('/');
    await expect(page.locator('.tab')).toHaveCount(1);

    await page.locator('.sidebar-foot').click();
    await page.getByTestId('sec-diagnostics').click();
    const panel = page.locator('.modal');
    await expect(panel).toContainText('跨 session 互傳訊息');
    await expect(panel).toContainText('✓ · claude 2.1.226');
  });

  /** An older CLI reads as "not yet", with the version that would fix it. */
  test('an older claude shows what is missing rather than a bare no', async ({ page }) => {
    await page.addInitScript(installMock);
    await page.addInitScript(() => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__;
      const original = internals.invoke.bind(internals);
      internals.invoke = (cmd: string, args?: unknown) =>
        cmd === 'boot_status'
          ? original(cmd, args).then((b) => ({
              ...(b as object),
              claudeVersion: '2.0.14',
              messaging: false,
            }))
          : original(cmd, args);
    });
    await page.goto('/');
    await expect(page.locator('.tab')).toHaveCount(1);

    await page.locator('.sidebar-foot').click();
    await page.getByTestId('sec-diagnostics').click();
    await expect(page.locator('.modal')).toContainText('需要 Claude Code ≥ 2.1.224（目前 2.0.14）');
  });
});
