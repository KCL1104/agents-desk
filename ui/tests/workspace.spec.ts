import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boardWithAttempt(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.getByTestId('view-board').click();

  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
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

    // It has no card of its own: on the board it sits in 進行中 as a session.
    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('loose-s2')).toContainText('▶ dev');
  });

  test('a repo without run scripts still offers the shell, and no ▶ buttons', async ({ page }) => {
    await boardWithAttempt(page);
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-empty')).toBeVisible();
    // The row holds what every worktree earns — your shell and the manual
    // checkpoint — and no ▶ buttons the repository never declared.
    await expect(page.getByTestId('open-shell')).toBeVisible();
    await expect(page.getByTestId('checkpoint-now')).toBeVisible();
    await expect(page.locator('[data-testid="run-scripts"] .chip')).toHaveCount(2);
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
      await page.getByRole('button', { name: '新增卡片', exact: true }).click();
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

  /** A repository inside WSL shares the board with local ones, so its card
      says which world it lives in, ahead of its name. */
  test('a wsl card wears its distro ahead of its repo name', async ({ page }) => {
    await page.addInitScript(installMock);
    await page.goto('/');
    await expect(page.locator('.tab')).toHaveCount(1);
    await page.evaluate(() => {
      window.__mock.repos['wsl://Ubuntu/home/me/webapp'] = ['main'];
    });
    await page.getByTestId('view-board').click();

    await page.getByRole('button', { name: '新增卡片', exact: true }).click();
    await page.getByTestId('task-title').fill('WSL 裡的卡');
    await page.getByTestId('task-prompt').fill('p');
    await page.getByTestId('task-repo').fill('wsl://Ubuntu/home/me/webapp');
    await page.getByTestId('task-branch').fill('main');
    await page.getByTestId('task-create').click();

    await expect(page.getByTestId('repo-k1')).toContainText('wsl:Ubuntu · webapp');
  });
});

/**
 * A card may span several repositories, because a change that has to land in
 * a service and its client is one piece of work and one conversation.
 *
 * The second repository is behind a button rather than in the form: nearly
 * every card has one, and a form that asks about the rare case makes everyone
 * pay for it.
 */
test.describe('a card that spans more than one repo', () => {
  async function boardWithTwoRepos(page: Page) {
    await page.addInitScript(installMock);
    await page.goto('/');
    await expect(page.locator('.tab')).toHaveCount(1);
    await page.evaluate(() => {
      window.__mock.repos['/Users/test/service'] = ['main', 'develop'];
    });
    await page.getByTestId('view-board').click();
    await page.getByRole('button', { name: '新增卡片', exact: true }).click();
    await page.getByTestId('task-prompt').fill('兩邊一起改');
    await page.getByTestId('task-repo').fill(REPO);
    await page.getByTestId('task-branch').fill('main');
  }

  test('the extra repo rows are opt-in and each carries its own base', async ({ page }) => {
    await boardWithTwoRepos(page);
    // Nothing about a second repository until somebody asks for one.
    await expect(page.getByTestId('task-repo-2')).toHaveCount(0);

    await page.getByTestId('task-add-repo').click();
    await page.getByTestId('task-repo-2').fill('/Users/test/service');
    await page.getByTestId('task-branch-2').fill('develop');
    await page.getByTestId('task-create').click();

    // Both reached the core, each with the base it was given.
    expect(
      await page.evaluate(() => {
        const t = window.__mock.tasks.at(-1)!;
        return [
          { repo_path: t.repo_path, base_branch: t.base_branch },
          ...(t.extra_repos ?? []),
        ];
      }),
    ).toEqual([
      { repo_path: REPO, base_branch: 'main' },
      { repo_path: '/Users/test/service', base_branch: 'develop' },
    ]);

    // The card says it spans two without listing both on one line, and the
    // whole list is a hover away.
    await expect(page.getByTestId('repo-k1')).toContainText('picked-repo +1');
    await expect(page.getByTestId('repo-k1')).toHaveAttribute(
      'title',
      `${REPO}\n/Users/test/service`,
    );
  });

  /** A row added and left blank blocks the create: it exists because
      somebody pressed a button, and dropping it silently would make a card
      with one fewer repository than they asked for. */
  test('a blank extra row holds the create until it is filled or removed', async ({ page }) => {
    await boardWithTwoRepos(page);
    await expect(page.getByTestId('task-create')).toBeEnabled();

    await page.getByTestId('task-add-repo').click();
    await expect(page.getByTestId('task-create')).toBeDisabled();

    await page.getByTestId('task-drop-repo-2').click();
    await expect(page.getByTestId('task-repo-2')).toHaveCount(0);
    await expect(page.getByTestId('task-create')).toBeEnabled();
  });

  /** The core refuses a card whose repositories are in two worlds, because
      the checkouts share a directory and a directory cannot straddle that
      boundary. The dialog is where the refusal is actionable. */
  test('a card spanning two worlds is refused where it can be fixed', async ({ page }) => {
    await boardWithTwoRepos(page);
    await page.evaluate(() => {
      window.__mock.repos['wsl://Ubuntu/home/me/service'] = ['main'];
    });
    await page.getByTestId('task-add-repo').click();
    await page.getByTestId('task-repo-2').fill('wsl://Ubuntu/home/me/service');
    await page.getByTestId('task-create').click();

    await expect(page.getByTestId('task-error')).toContainText('同一台主機');
    // The dialog is still open, with what was typed still in it.
    await expect(page.getByTestId('task-repo-2')).toHaveValue('wsl://Ubuntu/home/me/service');
    expect(await page.evaluate(() => window.__mock.tasks.length)).toBe(0);
  });

  /** Typing the service half of a two-repo card has to find it. */
  test('the palette searches every repo a card spans', async ({ page }) => {
    await boardWithTwoRepos(page);
    await page.getByTestId('task-add-repo').click();
    await page.getByTestId('task-repo-2').fill('/Users/test/service');
    await page.getByTestId('task-create').click();

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('service');
    await expect(page.locator('#palette-list')).toContainText('兩邊一起改');
  });

  /** The drawer has to be honest about what the second click will do, and
      about what came back from it. */
  test('the drawer names every base it merges into, and every PR it opened', async ({
    page,
  }) => {
    await boardWithTwoRepos(page);
    await page.getByTestId('task-add-repo').click();
    await page.getByTestId('task-repo-2').fill('/Users/test/service');
    await page.getByTestId('task-branch-2').fill('develop');
    await page.getByTestId('task-create').click();

    await page.locator('[data-testid="task-k1"] button.primary').click();
    await page.getByTestId('attempt-start').click();
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();

    // Both bases, because the merge writes to both.
    await expect(page.getByTestId('merge-attempt')).toHaveText('合併回 main、develop');

    // A pull request belongs to a repository, so two repos means two links —
    // never one joined string in a single href.
    await page.getByTestId('open-pr').click();
    await expect(page.getByTestId('pr-url')).toContainText('test/repo/pull/1');
    await expect(page.getByTestId('pr-url-2')).toContainText('test/service/pull/1');
    await expect(page.getByTestId('pr-url').locator('a')).toHaveAttribute(
      'href',
      'https://github.com/test/repo/pull/1',
    );
  });

  /** Two `CLAUDE.md` from two checkouts are two different files, and the
      Knows tab has to read as that rather than as one listed twice. */
  test('the knows tab tells two checkouts’ rules files apart', async ({ page }) => {
    await boardWithTwoRepos(page);
    await page.getByTestId('task-add-repo').click();
    await page.getByTestId('task-repo-2').fill('/Users/test/service');
    await page.getByTestId('task-create').click();
    await page.evaluate(() => {
      window.__mock.knowsDirs = ['repo', 'service'];
    });

    await page.locator('[data-testid="task-k1"] button.primary').click();
    await page.getByTestId('attempt-start').click();
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await page.getByTestId('inspector-knows-tab').click();

    await expect(page.getByTestId('knows-repo/CLAUDE.md')).toBeVisible();
    await expect(page.getByTestId('knows-service/CLAUDE.md')).toBeVisible();
    // The machine's own rules belong to nobody's checkout, so they stay bare.
    await expect(page.getByTestId('knows-CLAUDE.md')).toHaveCount(1);
  });
});
