import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

/** Boot with the one-shot surfaces re-armed — the mock normally
 *  pre-answers them so the rest of the suite never fights them. Re-armed
 *  once per tab, not per load: a reload must exercise the real
 *  persistence, not have the harness wiping it again. */
async function bootFresh(page: Page) {
  await page.addInitScript(installMock);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__rearmedOnce') === null) {
      sessionStorage.setItem('__rearmedOnce', '1');
      localStorage.removeItem('agentdesk.welcomed');
      localStorage.removeItem('agentdesk.coach');
    }
  });
  await page.goto('/');
}

async function newCard(page: Page, title: string) {
  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
}

test.describe('the first-run panel', () => {
  test('an empty desk is greeted with what the probe found', async ({ page }) => {
    await bootFresh(page);

    const modal = page.locator('.modal');
    await expect(modal).toContainText('歡迎使用 AgentDesk');
    // The detection report is the probe the app already ran, shown.
    await expect(page.getByTestId('welcome-claude')).toContainText('✓ 2.1.226');
    await expect(page.getByTestId('welcome-codex')).toContainText('找不到');
  });

  test('the primary way out is the first card', async ({ page }) => {
    await bootFresh(page);
    await page.getByTestId('welcome-card').click();

    // Straight into the board with the card dialog open — no dead end.
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('task-title')).toBeVisible();

    // And never again.
    await page.reload();
    await expect(page.getByTestId('task-title')).toHaveCount(0);
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('a desk already in use is never greeted', async ({ page }) => {
    // One surviving session marks the desk as lived-in. Seeded before the
    // mock installs, because it reads this storage as it loads.
    await page.addInitScript(() => {
      sessionStorage.setItem(
        '__mockSessions',
        JSON.stringify([
          {
            id: 's9', cwd: '/Users/test/app', title: 'app', agent: 'claude',
            status: 'saved', created_at: 1, last_active_at: 1, live: false,
            reports_status: false, activity: null, activity_since: 0,
            completed: false, attempt_id: null,
          },
        ]),
      );
    });
    await page.addInitScript(installMock);
    // Re-armed after the mock installs — the mock pre-answers it, and a
    // pre-answered welcome would make this test prove nothing.
    await page.addInitScript(() => {
      localStorage.removeItem('agentdesk.welcomed');
    });
    await page.goto('/');

    // A closed session files under 已完成, which starts collapsed — the
    // count on the section head is the proof the desk is lived-in.
    const done = page.locator('.section[data-section="done"]');
    await expect(done.locator('.section-count')).toHaveText('1');
    await expect(page.locator('.modal')).toHaveCount(0);
  });
});

test.describe('one-shot coaching', () => {
  test('the first attempt teaches the worktree, exactly once', async ({ page }) => {
    await bootFresh(page);
    await page.locator('.modal button', { hasText: '關閉' }).click();
    await page.getByTestId('view-board').click();
    await newCard(page, '修好登入');

    await page.locator('[data-testid="task-k1"] button.primary').click();
    await page.getByTestId('attempt-start').click();
    await expect(page.getByTestId('coach-attempt')).toBeVisible();
    await expect(page.getByTestId('coach-attempt')).toContainText('worktree');
    await page.getByTestId('coach-dismiss').click();
    await expect(page.getByTestId('coach-attempt')).toHaveCount(0);

    // A second attempt has nothing left to teach about worktrees.
    await page.getByTestId('view-board').click();
    await page.getByTestId('retry-k1').click();
    await page.getByTestId('attempt-start').click();
    await expect(page.locator('.pane:visible')).toHaveCount(2);
    await expect(page.getByTestId('coach-attempt')).toHaveCount(0);
  });

  test('a ⚡ start teaches the mode, not the worktree', async ({ page }) => {
    await bootFresh(page);
    await page.locator('.modal button', { hasText: '關閉' }).click();
    await page.getByTestId('view-board').click();
    await newCard(page, '修好登入');

    await page.locator('[data-testid="task-k1"] button.primary').click();
    await page.getByTestId('attempt-mode').selectOption('yolo');
    await page.getByTestId('attempt-start').click();

    // The sharper edge wins when both are new.
    await expect(page.getByTestId('coach-mode')).toBeVisible();
    await expect(page.getByTestId('coach-attempt')).toHaveCount(0);
  });

  test('the finish footer teaches finality before the second click', async ({ page }) => {
    await bootFresh(page);
    await page.locator('.modal button', { hasText: '關閉' }).click();
    await page.getByTestId('view-board').click();
    await newCard(page, '修好登入');
    await page.locator('[data-testid="task-k1"] button.primary').click();
    await page.getByTestId('attempt-start').click();

    // Dismiss the attempt mark so the drawer's own lesson can surface.
    await page.getByTestId('coach-dismiss').click();
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('coach-finish')).toBeVisible();
    await expect(page.getByTestId('coach-finish')).toContainText('最終');
  });
});

test.describe('notification preferences', () => {
  test('toggles persist and the test button fires one', async ({ page }) => {
    await page.addInitScript(installMock);
    await page.goto('/');
    await page.getByRole('button', { name: '環境' }).click();

    // The defaults the core ships: blocked states on, turn endings off.
    await expect(page.getByTestId('notify-permission')).toBeChecked();
    await expect(page.getByTestId('notify-input')).toBeChecked();
    await expect(page.getByTestId('notify-done')).not.toBeChecked();

    // A preference is not a form: the click is the save.
    await page.getByTestId('notify-done').click();
    const stored = await page.evaluate(() => window.__mock.notifyPrefs);
    expect(stored.done).toBe(true);

    await page.getByTestId('notify-test').click();
    await expect(page.getByTestId('notify-test')).toHaveText('已送出 ✓');
    const fired = await page.evaluate(
      () => window.__mock.calls.filter((c) => c.cmd === 'test_notification').length,
    );
    expect(fired).toBe(1);
  });
});

test.describe('checkpoints', () => {
  test('the environment panel owns the switch, default on', async ({ page }) => {
    await page.addInitScript(installMock);
    await page.goto('/');
    await page.getByRole('button', { name: '環境' }).click();

    // On by default — the retreat is the point; opting out is the choice.
    await expect(page.getByTestId('ckpt-toggle')).toBeChecked();

    await page.getByTestId('ckpt-toggle').click();
    const stored = await page.evaluate(() => window.__mock.checkpointsOn);
    expect(stored).toBe(false);
  });
});
