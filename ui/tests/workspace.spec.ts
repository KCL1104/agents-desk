import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boardWithAttempt(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.getByTestId('view-board').click();

  await page.getByRole('button', { name: '新增卡片' }).click();
  await page.getByTestId('task-title').fill('修好登入');
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();

  await page.locator('[data-testid="task-k1"] button.primary').click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();
}

test.describe('workspace scripts and the multi-repo board', () => {
  /**
   * M6's visible half: the repo's run scripts are one click from the drawer,
   * and the terminal they start is a real session pane beside the agent's.
   */
  test('a run script starts in its own terminal beside the agent', async ({ page }) => {
    await boardWithAttempt(page);
    await page.evaluate(() => {
      window.__mock.runScripts = ['dev', 'test'];
    });

    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('run-scripts')).toBeVisible();
    await expect(page.getByTestId('run-dev')).toContainText('dev');
    await expect(page.getByTestId('run-test')).toContainText('test');

    await page.getByTestId('run-dev').click();

    // A new pane opened for it, and the agent's own pane is still there.
    await expect(page.locator('.pane[data-session-id="s2"]')).toBeVisible();
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();

    // It is ad-hoc: on the board it lives in the ad-hoc strip, not on a card.
    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('adhoc-s2')).toContainText('▶ dev');
  });

  test('a repo without run scripts shows no run row', async ({ page }) => {
    await boardWithAttempt(page);
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-empty')).toBeVisible();
    await expect(page.getByTestId('run-scripts')).toHaveCount(0);
  });

  /**
   * Cards from different repositories share one board — the desk is the
   * point — so each card says which codebase and base branch it is about.
   */
  test('every card names its repository and base branch', async ({ page }) => {
    await page.addInitScript(installMock);
    await page.goto('/');
    await expect(page.locator('.tab')).toHaveCount(1);
    await page.evaluate(() => {
      window.__mock.repos['/Users/test/other-app'] = ['main'];
    });
    await page.getByTestId('view-board').click();

    for (const [title, repo] of [
      ['修好登入', '/Users/test/picked-repo'],
      ['另一個 app 的卡', '/Users/test/other-app'],
    ]) {
      await page.getByRole('button', { name: '新增卡片' }).click();
      await page.getByTestId('task-title').fill(title);
      await page.getByTestId('task-prompt').fill('p');
      await page.getByTestId('task-repo').fill(repo);
      await page.getByTestId('task-branch').fill('main');
      await page.getByTestId('task-create').click();
    }

    await expect(page.getByTestId('repo-k1')).toContainText('picked-repo');
    await expect(page.getByTestId('repo-k2')).toContainText('other-app');
    await expect(page.getByTestId('repo-k2')).toContainText('⎇ main');
    // The full path is a hover away, not taking up card space.
    await expect(page.getByTestId('repo-k2')).toHaveAttribute(
      'title',
      '/Users/test/other-app',
    );
  });
});
