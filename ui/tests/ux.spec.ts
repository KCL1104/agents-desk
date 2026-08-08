import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.tab')).toHaveCount(1);
}

async function toBoard(page: Page) {
  await page.getByTestId('view-board').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function newCard(page: Page, title: string) {
  await page.getByRole('button', { name: '新增卡片' }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
}

async function start(page: Page, taskId: string) {
  await page.locator(`[data-testid="task-${taskId}"] button.primary`).click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  await page.getByTestId('attempt-start').click();
}

test.describe('the payoff click', () => {
  test('the waiting banner lands you in the terminal from any view', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await toBoard(page);
    await page.evaluate(() => window.__mock.report('s1', 'waiting_permission'));

    // The moment of highest urgency: the click has to visibly answer.
    await page.locator('.waiting-banner').click();
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane:visible')).toHaveCount(1);
  });

  test('a sidebar row opens the terminal view too', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await toBoard(page);

    await page.locator('[data-testid="session-s1"]').click();
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane:visible')).toHaveCount(1);
  });
});

test.describe('dialogs behave like dialogs', () => {
  test('Escape closes a clean dialog', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await page.getByRole('button', { name: '新增卡片' }).click();
    await expect(page.locator('.modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('a stray backdrop click cannot discard typed content', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await page.getByRole('button', { name: '新增卡片' }).click();
    await page.getByTestId('task-prompt').fill('好幾分鐘打出來的 prompt');

    // Dirty: the backdrop refuses.
    await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.modal')).toBeVisible();

    // Escape is deliberate in a way a mis-aimed click is not: it still works.
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('a clean backdrop click still closes', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await page.getByRole('button', { name: '新增卡片' }).click();
    await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.modal')).toHaveCount(0);
  });

  test('Tab stays inside an open dialog', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await page.getByRole('button', { name: '新增卡片' }).click();
    // Walk far enough to have wrapped at least once.
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() =>
        document.querySelector('.modal')?.contains(document.activeElement),
      );
      expect(inside).toBe(true);
    }
  });
});

test.describe('the keyboard can drive', () => {
  test('a session row is focusable and Enter opens it', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await toBoard(page);

    await page.locator('[data-testid="session-s1"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane:visible')).toHaveCount(1);
  });

  test('row actions become visible when focus reaches them', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await toBoard(page);

    const actions = page.locator('[data-testid="session-s1"] .row-actions');
    await expect(actions).toHaveCSS('opacity', '0');
    await page.locator('[data-testid="session-s1"] .row-action').first().focus();
    await expect(actions).toHaveCSS('opacity', '1');
  });

  test('⌘/Ctrl+1/2/3 switch views', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('ControlOrMeta+2');
    await expect(page.getByTestId('board')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+3');
    await expect(page.locator('.ov-grid, .overview, [data-testid="overview"]').first()).toBeVisible();
    await page.keyboard.press('ControlOrMeta+1');
    await expect(page.getByTestId('board')).toHaveCount(0);
  });

  test('⌘/Ctrl+E jumps to the session that is waiting', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await toBoard(page);
    await page.evaluate(() => window.__mock.report('s1', 'waiting_permission'));

    await page.keyboard.press('ControlOrMeta+e');
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane:visible')).toHaveCount(1);
  });

  test('⌘/Ctrl+Alt+arrows cycle the focused pane', async ({ page }) => {
    await boot(page);
    // Two ad-hoc sessions straight into the wall.
    for (const dir of ['/Users/test/repo-one', '/Users/test/repo-two']) {
      await page.locator('.sidebar-head button.icon').click();
      await page.locator('.modal input.mono').first().fill(dir);
      await page.locator('.modal button.primary').click();
    }
    await expect(page.locator('.pane:visible')).toHaveCount(2);
    await expect(page.locator('.pane.focused')).toHaveAttribute('data-session-id', 's2');

    await page.keyboard.press('ControlOrMeta+Alt+ArrowRight');
    await expect(page.locator('.pane.focused')).toHaveAttribute('data-session-id', 's1');
    await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft');
    await expect(page.locator('.pane.focused')).toHaveAttribute('data-session-id', 's2');
  });

  test('Ctrl+PgDn / PgUp cycle tabs', async ({ page }) => {
    await boot(page);
    await page.locator('.tab-add').click();
    await expect(page.locator('.tab')).toHaveCount(2);
    // A fresh tab opens in rename mode; keep the offered name and move on.
    await page.keyboard.press('Escape');
    await expect(page.locator('.tab.active')).toContainText('工作 2');

    await page.keyboard.press('Control+PageDown');
    await expect(page.locator('.tab.active')).toContainText('工作區');
    await page.keyboard.press('Control+PageUp');
    await expect(page.locator('.tab.active')).toContainText('工作 2');
  });

  test('⌘/Ctrl+I toggles the inspector beside the terminal', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await expect(page.locator('.pane:visible')).toHaveCount(1);

    // From outside the terminal the plain chord works; inside it, readline
    // owns Ctrl+I (it is Tab), so the Shift variant is the one that fires.
    await page.locator('.topbar').click();
    await page.keyboard.press('ControlOrMeta+i');
    await expect(page.getByTestId('inspector')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+i');
    await expect(page.getByTestId('inspector')).toHaveCount(0);

    await page.locator('.term-host').first().click();
    await page.keyboard.press('ControlOrMeta+Shift+I');
    await expect(page.getByTestId('inspector')).toBeVisible();
  });

  test('⌘/Ctrl+/ shows the cheat sheet and Escape puts it away', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('ControlOrMeta+/');
    await expect(page.getByTestId('shortcuts')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts')).toHaveCount(0);
  });

  test('j and k walk the commentable diff lines', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await toBoard(page);
    await page.evaluate(() => {
      window.__mock.diffs.set('k1-a1', [
        'diff --git a/src/auth.py b/src/auth.py',
        '--- a/src/auth.py',
        '+++ b/src/auth.py',
        '@@ -10,3 +10,4 @@',
        ' def login(request):',
        '+    session = make_session(user)',
        '+    return session',
      ].join('\n'));
    });
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-body')).toBeVisible();

    await page.getByTestId('diff-body').focus();
    await page.keyboard.press('j');
    await expect(page.locator('.diff-line.commentable').first()).toBeFocused();
    await page.keyboard.press('j');
    await expect(page.locator('.diff-line.commentable').nth(1)).toBeFocused();
    await page.keyboard.press('k');
    await expect(page.locator('.diff-line.commentable').first()).toBeFocused();

    // Enter on the focused line opens the composer for exactly that line.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('review-note')).toBeVisible();
  });

  test('a board card is enterable with Enter', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await toBoard(page);

    await page.locator('[data-testid="task-k1"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane:visible')).toHaveCount(1);
  });
});

test.describe('outcomes say so', () => {
  test('merging an attempt gets its confirmation toast', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await toBoard(page);
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('inspector')).toBeVisible();

    await page.getByTestId('merge-attempt').click();
    await expect(page.locator('.toast.ok')).toContainText('已合併回 main');
  });

  test('the delete arm disarms by itself', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');

    await page.getByRole('button', { name: '刪除卡片' }).click();
    await expect(page.getByTestId('confirm-delete-k1')).toBeVisible();
    // Not clicking again: the armed state must give up on its own.
    await expect(page.getByRole('button', { name: '刪除卡片' })).toBeVisible({
      timeout: 6000,
    });
    await expect(page.locator('.board-card')).toHaveCount(1);
  });

  test('a closed session does not sit in 等待輸入', async ({ page }) => {
    await boot(page);
    await toBoard(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await toBoard(page);
    await page.evaluate(() => window.__mock.report('s1', 'waiting_permission'));
    await expect(page.locator('[data-section="waiting"] .session-row')).toHaveCount(1);

    await page.evaluate(() => {
      const s = window.__mock.sessions.find((x) => x.id === 's1');
      if (s) {
        s.live = false;
        s.status = 'saved';
      }
      window.__mock.emit('sessions:changed', window.__mock.sorted());
    });
    // 已完成 starts collapsed, so count the section's own badge, and the
    // now-empty waiting section unrenders entirely.
    await expect(page.locator('[data-section="done"] .section-count')).toHaveText('1');
    await expect(page.locator('[data-section="waiting"]')).toHaveCount(0);
  });
});
