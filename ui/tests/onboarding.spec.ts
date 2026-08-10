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

  test('a true first run lands on the board, with the long first-card invitation', async ({
    page,
  }) => {
    await bootFresh(page);
    // 歡迎面板浮在看板上;關掉它,腳下已經是看板 —— 不是空的終端牆。
    await page.locator('.modal button', { hasText: '關閉' }).click();
    await expect(page.getByTestId('board')).toBeVisible();
    // 整張桌子還沒有卡片:CTA 說完整的一句。
    await expect(page.getByTestId('board-cta')).toHaveText(
      '開第一張卡 —— 一個 repo、一個分支、一件要做的事',
    );
    // 有了第一張卡,短標籤就夠了(backlog 空著時才有 CTA 可看:把卡
    // 拖去進行中就看得到)。
  });

  test('the mental model wears the board’s dot vocabulary, statically', async ({ page }) => {
    await bootFresh(page);
    const rail = page.locator('.welcome-rail-row');
    await expect(rail).toHaveCount(3);
    await expect(rail.nth(0)).toContainText('一張卡片');
    await expect(rail.nth(2)).toContainText('合');
  });

  test('a machine with no agent CLI wears the amber banner, and probe again repaints', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem(
        '__mockAgents',
        JSON.stringify([
          { name: 'claude', path: null },
          { name: 'codex', path: null },
          { name: 'gemini', path: null },
          { name: 'aider', path: null },
        ]),
      );
    });
    await bootFresh(page);
    await expect(page.getByTestId('welcome-no-agents')).toBeVisible();
    await expect(page.getByTestId('welcome-no-agents')).toContainText(
      '找不到任何 agent CLI',
    );

    // 裝好 CLI 之後按「重新偵測」:真的重跑 boot_status,發現就換新。
    await page.evaluate(() =>
      sessionStorage.setItem(
        '__mockAgents',
        JSON.stringify([
          { name: 'claude', path: '/usr/local/bin/claude' },
          { name: 'codex', path: null },
          { name: 'gemini', path: null },
          { name: 'aider', path: null },
        ]),
      ),
    );
    await page.getByTestId('welcome-reprobe').click();
    await expect(page.getByTestId('welcome-claude')).toContainText('✓');
    await expect(page.getByTestId('welcome-no-agents')).toHaveCount(0);
  });

  test('the welcome panel reopens from the environment panel, flags untouched', async ({
    page,
  }) => {
    await page.addInitScript(installMock);
    await page.goto('/');
    await page.getByRole('button', { name: '環境' }).click();
    await page.getByTestId('show-welcome').click();
    await expect(page.locator('.modal')).toContainText('歡迎使用 AgentDesk');

    // 重看不是重來:旗標留著,重新整理不會再被招呼。
    await page.locator('.modal button', { hasText: '關閉' }).click();
    const flag = await page.evaluate(() => localStorage.getItem('agentdesk.welcomed'));
    expect(flag).toBe('1');
    await page.reload();
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('the welcome panel reopens from the palette too', async ({ page }) => {
    await page.addInitScript(installMock);
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+K');
    await page.getByTestId('palette-input').fill('歡迎');
    await page.getByTestId('pal-action-show-welcome').click();
    await expect(page.locator('.modal')).toContainText('歡迎使用 AgentDesk');
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

  test('the first turn into waiting teaches the amber breath, exactly once', async ({
    page,
  }) => {
    await bootFresh(page);
    await page.locator('.modal button', { hasText: '關閉' }).click();
    await newCard(page, '修好登入');
    await page.locator('[data-testid="task-k1"] button.primary').click();
    await page.getByTestId('attempt-start').click();

    // 出生就停在信任門上教的是 attempt(worktree 與信任門是同一課);
    // 等待的課留給真正「從在做轉進等你」的那一刻。
    await expect(page.getByTestId('coach-attempt')).toBeVisible();
    await expect(page.getByTestId('coach-waiting')).toHaveCount(0);
    await page.getByTestId('coach-dismiss').click();

    await page.evaluate(() => window.__mock.report('s1', 'running'));
    // 先等「在做」真的畫出來:兩個 report 若在同一幀被批次合併,app
    // 根本沒看見 running,working→等你 的轉換就不存在 —— CI 比本機慢
    // 一拍,恰好照出這個時序假設(這裡修的是測試,不是 app 的規則)。
    await expect(page.locator('.dot.running').first()).toBeVisible();
    await page.evaluate(() => window.__mock.report('s1', 'waiting_permission'));
    await expect(page.getByTestId('coach-waiting')).toBeVisible();
    await expect(page.getByTestId('coach-waiting')).toContainText('琥珀');
    await page.getByTestId('coach-dismiss').click();

    // 第二次等待沒有課可教 —— 同樣先讓 running 落幀,否則轉換沒發生,
    // 「沒有課」就是白驗的。
    await page.evaluate(() => window.__mock.report('s1', 'running'));
    await expect(page.locator('.dot.running').first()).toBeVisible();
    await page.evaluate(() => window.__mock.report('s1', 'waiting_input'));
    await expect(page.locator('.dot.waiting_input').first()).toBeVisible();
    await expect(page.getByTestId('coach-waiting')).toHaveCount(0);
  });
});

test.describe('the first-run terminal wall', () => {
  test('the empty wall teaches three keys, and retires once any session exists', async ({
    page,
  }) => {
    await bootFresh(page);
    await page.locator('.modal button', { hasText: '關閉' }).click();
    // 第一次落在看板;去看終端牆。
    await page.keyboard.press('ControlOrMeta+1');
    await expect(page.getByTestId('term-keymap')).toBeVisible();
    await expect(page.getByTestId('term-keymap')).toContainText('終端牆 · 看板 · 總覽');
    await expect(page.getByTestId('term-keymap')).toContainText('全部快捷鍵');

    // 開過 session 之後讓位:退出佈局後的空網格說的是老話,不再上課。
    await page.locator('.sidebar-head button.icon').click();
    await page.locator('.modal input.mono').first().fill('/Users/test/repo-one');
    await page.locator('.modal button.primary').click();
    await expect(page.locator('.pane:visible')).toHaveCount(1);
    await page.getByTestId('eject-s1').click();
    await expect(page.getByTestId('empty-grid')).toBeVisible();
    await expect(page.getByTestId('term-keymap')).toHaveCount(0);
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
