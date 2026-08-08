// A camera, not a test: walks the app into a representative state and
// captures every screen, so UI changes can be judged by eye.
//
//   SHOT_DIR=/somewhere npx playwright test screenshots
//
// Without SHOT_DIR it skips, so the ordinary test run never pays for it.
import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const OUT = process.env.SHOT_DIR;
test.skip(!OUT, 'set SHOT_DIR to capture screenshots');
const REPO = '/Users/test/picked-repo';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
}

async function card(page: Page, title: string, repo = REPO) {
  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-prompt').fill('把它修好，先重現再改。');
  await page.getByTestId('task-repo').fill(repo);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
}

test('capture the app', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    window.__mock.repos['wsl://Ubuntu/home/me/webapp'] = ['main'];
    window.__mock.profiles = [{ name: 'opus 版', agent: 'claude', args: ['--model', 'opus'] }];
    window.__mock.runScripts = ['dev', 'test'];
  });
  await page.getByTestId('view-board').click();

  // A board with life on it.
  await card(page, '修好登入頁在 Safari 的白畫面');
  await card(page, '重構 payments API');
  await card(page, 'WSL 裡的資料匯入工具', 'wsl://Ubuntu/home/me/webapp');
  await card(page, '寫 onboarding 文件');

  // k1: running, with activity.
  await page.locator('[data-testid="task-k1"] button.primary').click();
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();
  await page.evaluate(() => {
    window.__mock.report('s1', 'running', { tool: 'Bash', detail: 'pytest tests/test_auth.py -v' });
  });

  // k2: yolo + waiting on permission.
  await page.locator('[data-testid="task-k2"] button.primary').click();
  await page.getByTestId('attempt-mode').selectOption('yolo');
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();
  await page.evaluate(() => window.__mock.report('s2', 'waiting_permission'));

  // k3: wsl card, started then stopped.
  await page.locator('[data-testid="task-k3"] button.primary').click();
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();
  await page.evaluate(() => {
    const s = window.__mock.sessions.find((x) => x.id === 's3');
    if (s) { s.live = false; s.status = 'saved'; }
    window.__mock.emit('sessions:changed', window.__mock.sorted());
  });

  // An ad-hoc session too.
  await page.locator('.sidebar-head button.icon').click();
  await page.locator('.modal input.mono').first().fill('/Users/test/scratch');
  await page.locator('.modal button.primary').click();
  await page.getByTestId('view-board').click();

  // Drag k4 conceptually: move to review via mock api.
  await page.evaluate(async () => {
    const internals = (window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
    }).__TAURI_INTERNALS__;
    await internals.invoke('move_task', { id: 'k4', lifecycle: 'review', position: 0 });
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/1-board.png` });

  // Terminal + inspector with a review comment in flight.
  await page.evaluate(() => {
    window.__mock.diffs.set('k1-a1', [
      'diff --git a/src/auth.py b/src/auth.py',
      'index 1111111..2222222 100644',
      '--- a/src/auth.py',
      '+++ b/src/auth.py',
      '@@ -10,6 +10,8 @@ def login():',
      ' def login(request):',
      '     user = request.user',
      '-    return None',
      '+    session = make_session(user)',
      '+    return session',
      ' ',
      ' def logout(request):',
    ].join('\n'));
    window.__mock.record('k1-a1', 'tool', 'Bash', 'pytest tests/test_auth.py -v');
    window.__mock.record('k1-a1', 'tool', 'Edit', '/repo/src/auth.py');
  });
  await page.getByTestId('inspect-k1').click();
  await expect(page.getByTestId('diff-body')).toBeVisible();
  await page.locator('.diff-line.add').first().click();
  await page.getByTestId('review-note').fill('session 可能是 undefined，要先檢查再回傳');
  await page.getByTestId('review-add').click();
  await page.locator('.diff-line', { hasText: 'def login(request):' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/2-inspector.png` });

  // Activity tab.
  await page.getByTestId('inspector-timeline-tab').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/3-activity.png` });

  // Start dialog with yolo hint.
  await page.getByTestId('view-board').click();
  await page.locator('[data-testid="task-k4"] button.primary').click();
  await page.getByTestId('attempt-mode').selectOption('yolo');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/4-start-dialog.png` });
  await page.getByRole('button', { name: '取消' }).click();

  // Env panel with profiles.
  await page.locator('.sidebar-foot').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/5-env.png` });
  await page.getByRole('button', { name: '關閉' }).click();

  // Overview.
  await page.getByRole('tab', { name: '總覽' }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/6-overview.png` });

  // New card dialog.
  await page.getByTestId('view-board').click();
  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/7-new-card.png` });
});
