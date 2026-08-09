import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

/**
 * Worlds v1 — the bottom-left world switch and the per-dialog override.
 *
 * The acceptance line from docs/decisions/worlds.md: nobody types `wsl://`
 * by hand. The picker sets where new things open, the dialogs compose the
 * scheme, Explorer's UNC paths normalize, and a world that refuses the
 * probe says why in full — right on its row.
 */

const WSL_REPO = 'wsl://Ubuntu/home/me/proj';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
}

async function bootToBoard(page: Page) {
  await boot(page);
  await page.getByTestId('view-board').click();
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate((repo) => {
    window.__mock.repos[repo] = ['main'];
  }, WSL_REPO);
}

/** Fill the new-card form around the repo field the test cares about. */
async function fillCard(page: Page, repo: string) {
  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.getByTestId('task-title').fill('在 WSL 修');
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(repo);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
}

test.describe('worlds', () => {
  test('picking WSL bottom-left makes a plain path open there, badge and all', async ({
    page,
  }) => {
    await bootToBoard(page);

    // The chip starts at home, and the menu enumerates without inventing.
    await expect(page.getByTestId('world-chip')).toContainText('本機');
    await page.getByTestId('world-chip').click();
    await expect(page.getByTestId('world-menu')).toBeVisible();
    await expect(page.getByTestId('world-local')).toBeVisible();
    await expect(page.getByTestId('world-ssh-devbox')).toBeVisible();

    // Picking probes lazily — the answer lands on the row that was clicked.
    await page.getByTestId('world-wsl-Ubuntu').click();
    await expect(page.getByTestId('world-wsl-Ubuntu')).toContainText('2.1.226');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('world-menu')).not.toBeVisible();
    await expect(page.getByTestId('world-chip')).toContainText('WSL: Ubuntu');

    // The dialog inherits the default; the person types only a plain path.
    await page.getByRole('button', { name: '新增卡片', exact: true }).click();
    await expect(page.getByTestId('task-world')).toHaveValue('wsl://Ubuntu');
    await page.getByTestId('task-title').fill('在 WSL 修');
    await page.getByTestId('task-prompt').fill('把它修好');
    await page.getByTestId('task-repo').fill('/home/me/proj');
    await page.getByTestId('task-branch').fill('main');
    await page.getByTestId('task-create').click();

    // The card stores the scheme and wears the world.
    await expect(page.locator('.host-badge')).toContainText('wsl:Ubuntu');
    expect(await page.evaluate(() => window.__mock.tasks.at(-1)?.repo_path)).toBe(WSL_REPO);
  });

  test('a pasted \\\\wsl$ UNC path lands as the same wsl:// card', async ({ page }) => {
    await bootToBoard(page);

    // No picker touched — the path Explorer's address bar hands out is
    // enough on its own, backslashes, dollar sign and all.
    await fillCard(page, '\\\\wsl$\\Ubuntu\\home\\me\\proj');

    await expect(page.locator('.host-badge')).toContainText('wsl:Ubuntu');
    expect(await page.evaluate(() => window.__mock.tasks.at(-1)?.repo_path)).toBe(WSL_REPO);
  });

  test('the default world survives a reload', async ({ page }) => {
    await boot(page);
    await page.getByTestId('world-chip').click();
    await page.getByTestId('world-wsl-Ubuntu').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('world-chip')).toContainText('WSL: Ubuntu');

    await page.reload();
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.getByTestId('world-chip')).toContainText('WSL: Ubuntu');
  });

  test('a world that cannot be reached says why, in full, on its row', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => {
      window.__mock.worldProbes.set('ssh://devbox', {
        claude: null,
        error: 'ssh: connect to host devbox port 22: Connection refused',
      });
      window.__mock.worldProbes.set('wsl://Ubuntu', { claude: null, error: null });
    });

    await page.getByTestId('world-chip').click();
    await page.getByTestId('world-ssh-devbox').click();
    // The whole refusal, not a sad-face summary — and the pick still
    // holds: a default is where things will open, not a live connection.
    await expect(page.getByTestId('world-ssh-devbox')).toContainText(
      'ssh: connect to host devbox port 22: Connection refused',
    );
    await expect(page.getByTestId('world-chip')).toContainText('SSH: devbox');

    // A reachable world without claude is its own honest answer.
    await page.getByTestId('world-wsl-Ubuntu').click();
    await expect(page.getByTestId('world-wsl-Ubuntu')).toContainText('找不到 claude');
  });

  test('the new-session dialog composes the world the same way', async ({ page }) => {
    await boot(page);
    await page.locator('.sidebar-head button.icon').click();
    await expect(page.locator('.modal')).toBeVisible();

    await page.getByTestId('session-world').selectOption('wsl://Ubuntu');
    await page.locator('.modal input.mono').first().fill('/home/me/proj');
    await page.getByRole('button', { name: '開啟終端機', exact: true }).click();

    await expect
      .poll(() => page.evaluate(() => window.__mock.sessions.at(-1)?.cwd))
      .toBe('wsl://Ubuntu/home/me/proj');
  });
});
