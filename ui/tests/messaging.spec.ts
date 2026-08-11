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

  /**
   * The diagnostics list both CLIs this desk knows how to drive, and for
   * each one the two facts that decide what a card can do: whether it is
   * installed, and whether the installed version reports status. Those are
   * different answers — a Codex too old for its hooks engine runs a session
   * perfectly and tells the desk nothing — and a panel that only said
   * "found" would leave the commonest blank card unexplained.
   */
  test('the diagnostics name both CLIs, and say which of them reports status', async ({
    page,
  }) => {
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
              codex: '/usr/local/bin/codex',
              codexVersion: '0.100.0',
              agents: [
                { name: 'claude', path: '/usr/local/bin/claude', version: '2.1.226', reports: true },
                // Installed, and older than the hooks engine this desk
                // wires up: found, but quiet.
                { name: 'codex', path: '/usr/local/bin/codex', version: '0.100.0', reports: false },
              ],
            }))
          : original(cmd, args);
    });
    await page.goto('/');
    await expect(page.locator('.tab')).toHaveCount(1);

    await page.locator('.sidebar-foot').click();
    await page.getByTestId('sec-diagnostics').click();
    const panel = page.locator('.modal');
    await expect(panel).toContainText('/usr/local/bin/claude · 2.1.226 · 狀態回報 ✓');
    await expect(panel).toContainText('/usr/local/bin/codex · 0.100.0 · 沒有狀態回報');
  });
});
