import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

/**
 * The folder picker, and the one thing it exists to get right: it browses the
 * world the card will run in, not the machine the app is running on.
 *
 * A platform folder dialog cannot do that. It reads the local filesystem —
 * which for a WSL card is the Windows side, and for an SSH host is a
 * filesystem that is not mounted at all. The mock gives each world a
 * different tree under the same path names so a test can tell them apart.
 */

async function land(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
}

async function openSessionPicker(page: Page, world?: string) {
  await page.locator('.sidebar-head button.icon').click();
  await expect(page.locator('.modal')).toBeVisible();
  if (world) await page.getByTestId('session-world').selectOption(world);
  await page.getByTestId('session-pick').click();
  await expect(page.getByTestId('dirpick-list')).toBeVisible();
}

test.describe('choosing a directory inside a world', () => {
  /** The default world, opening where a person starts: home. */
  test('it opens at the world’s own home', async ({ page }) => {
    await land(page);
    await openSessionPicker(page);

    await expect(page.getByTestId('dirpick-path')).toHaveValue('/home/you');
    await expect(page.getByTestId('dirpick-row-code')).toBeVisible();
  });

  /** The whole point. Same path, different machine, different contents —
      and no native dialog could have told them apart. */
  test('a WSL card lists the distro, not this machine', async ({ page }) => {
    await land(page);
    await openSessionPicker(page, 'wsl://Ubuntu');

    await expect(page.getByTestId('dirpick-row-service')).toBeVisible();
    await expect(page.getByTestId('dirpick-row-client')).toBeVisible();
    // `code` and `Downloads` are the local machine's. Their absence is the
    // evidence that this list came from the distro.
    await expect(page.getByTestId('dirpick-row-code')).toHaveCount(0);
    await expect(page.getByTestId('dirpick-row-Downloads')).toHaveCount(0);
  });

  /** And the world that has no local filesystem to fall back on at all. */
  test('an SSH host lists the host', async ({ page }) => {
    await land(page);
    await openSessionPicker(page, 'ssh://devbox');

    await expect(page.getByTestId('dirpick-row-deploy')).toBeVisible();
    await expect(page.getByTestId('dirpick-row-code')).toHaveCount(0);
  });

  /** Which machine a list is of cannot be read off the paths in it. */
  test('the picker names the world it is showing', async ({ page }) => {
    await land(page);
    await openSessionPicker(page, 'wsl://Ubuntu');
    await expect(page.getByTestId('dirpick-world')).toContainText('WSL: Ubuntu');
  });

  /** Descending, and the way back up. */
  test('clicking a row goes into it, and .. comes back', async ({ page }) => {
    await land(page);
    await openSessionPicker(page);

    await page.getByTestId('dirpick-row-code').click();
    await expect(page.getByTestId('dirpick-path')).toHaveValue('/home/you/code');
    await expect(page.getByTestId('dirpick-row-picked-repo')).toBeVisible();

    await page.getByTestId('dirpick-row-..').click();
    await expect(page.getByTestId('dirpick-path')).toHaveValue('/home/you');
  });

  /** Typing is the fast path: somebody who knows the path never touches
      the list. */
  test('a typed path goes straight there', async ({ page }) => {
    await land(page);
    await openSessionPicker(page);

    await page.getByTestId('dirpick-path').fill('/home/you/code/picked-repo');
    await page.getByTestId('dirpick-path').press('Enter');

    await expect(page.getByTestId('dirpick-repo')).toBeVisible();
  });

  /** Said where it is true, so nobody has to descend to find out. */
  test('a checkout is called out where it stands', async ({ page }) => {
    await land(page);
    await openSessionPicker(page);

    await expect(page.getByTestId('dirpick-repo')).toHaveCount(0);
    await page.getByTestId('dirpick-row-code').click();
    await page.getByTestId('dirpick-row-picked-repo').click();
    await expect(page.getByTestId('dirpick-repo')).toBeVisible();
  });

  /** A typo must not cost somebody the directory they had navigated to. */
  test('a bad path reports itself and keeps the list', async ({ page }) => {
    await land(page);
    await openSessionPicker(page);
    await page.getByTestId('dirpick-row-code').click();

    await page.getByTestId('dirpick-path').fill('/nope/not/here');
    await page.getByTestId('dirpick-path').press('Enter');

    await expect(page.getByTestId('dirpick-error')).toBeVisible();
    // Still standing where it was.
    await expect(page.getByTestId('dirpick-row-picked-repo')).toBeVisible();
  });

  /** The keyboard walks the list and Enter descends — the same as clicking,
      because the whole triage loop is keyboard-drivable and a modal that
      forces the mouse would be the one place it stops. */
  test('the list is walkable from the keyboard', async ({ page }) => {
    await land(page);
    await openSessionPicker(page);

    const path = page.getByTestId('dirpick-path');
    await path.press('ArrowDown'); // '..'
    await path.press('ArrowDown'); // 'code'
    await path.press('Enter');

    await expect(page.getByTestId('dirpick-path')).toHaveValue('/home/you/code');
  });

  /** Picking hands the path back to the field that asked for it. */
  test('the chosen path lands in the dialog underneath', async ({ page }) => {
    await land(page);
    await openSessionPicker(page);

    await page.getByTestId('dirpick-row-code').click();
    await page.getByTestId('dirpick-ok').click();

    await expect(page.getByTestId('dirpick-list')).toHaveCount(0);
    await expect(page.locator('input.mono').first()).toHaveValue('/home/you/code');
  });
});
