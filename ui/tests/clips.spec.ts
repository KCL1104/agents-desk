// 功能短片:一個功能一支,不是一支大影片。
//
//   CLIP_DIR=../docs/media/.rec npx playwright test clips
//
// 沒設 CLIP_DIR 就跳過,所以平常的測試不用付這個代價。
// 錄影本身交給 Playwright;轉成 GIF 的是 scripts/readme-clips.mjs,
// 每支片自己一張調色盤 —— 一張全域調色盤要同時吃下終端機語法上色、
// 四種狀態色和 diff 紅綠,那就是原本 README 影片顏色跑掉的原因。
import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const OUT = process.env.CLIP_DIR;
test.skip(!OUT, 'set CLIP_DIR to record feature clips');
test.use({ video: { mode: 'on', size: { width: 1280, height: 800 } } });

const REPO = '/Users/me/webapp';

/** 每個動作之後停一拍。影格落在重繪中間,就是舊影片裡 TUI 畫壞的來源。 */
async function beat(page: Page, ms = 700) {
  await page.waitForTimeout(ms);
}

async function boot(page: Page) {
  await page.addInitScript(installMock);
  // 每支片一個新 context,所以歡迎面板與 coach 記號都是全新的。它們各自
  // 有專屬的片子;在別支片裡冒出來只是噪音,所以這裡先答過。
  await page.addInitScript(() => {
    localStorage.setItem('agentdesk.welcomed', '1');
    localStorage.setItem(
      'agentdesk.coach',
      JSON.stringify({ attempt: true, mode: true, finish: true, terminal: true, waiting: true }),
    );
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  // 影片裡的路徑要像真的,所以先讓 mock 認得它。
  await page.evaluate((repo) => { window.__mock.repos[repo] = ['main', 'release']; }, REPO);
  await page.getByTestId('view-board').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function card(page: Page, title: string, prompt: string) {
  // 空板時走 CTA(第一次的自然動作,畫面也好看),之後走欄頭的 ＋。
  const cta = page.getByTestId('board-cta');
  if (await cta.count()) await cta.click();
  else await page.locator('.board-col-head button.icon').first().click();
  await beat(page, 300);
  await page.getByTestId('task-prompt').fill(prompt);
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await beat(page, 300);
  await page.getByTestId('task-create').click();
  await beat(page, 400);
}

test('triage', async ({ page }) => {
  await boot(page);
  await card(page, '修好登入頁的白畫面', '登入後畫面全白,先重現再修。');
  await card(page, '重構 payments API', '把重複的錯誤處理收斂掉。');
  for (const k of ['k1', 'k2']) {
    await page.locator(`[data-testid="task-${k}"] button.primary`).click();
    await beat(page, 400);
    await page.getByTestId('attempt-start').click();
    await beat(page, 500);
    await page.getByTestId('view-board').click();
  }
  await beat(page);
  await page.evaluate(() => {
    window.__mock.report('s1', 'running', { tool: 'Bash', detail: 'pytest tests/test_auth.py -v' });
  });
  await beat(page);
  // 一張卡片轉成「等你」:琥珀色的呼吸,桌上唯一會脈動的東西。
  await page.evaluate(() => window.__mock.report('s2', 'waiting_permission'));
  await beat(page, 1400);
  // ⌘E 跳過去 —— 分流迴圈的那一顆鍵。
  await page.keyboard.press('ControlOrMeta+e');
  await beat(page, 1600);
});

test('compose', async ({ page }) => {
  await boot(page);
  await card(page, '既有的卡片', '先放著');
  await beat(page);
  await page.keyboard.press('ControlOrMeta+K');
  await beat(page, 500);
  // 打一句話,它就是一張卡 —— 不是搜尋結果。
  await page.getByTestId('palette-input').pressSequentially('把 onboarding 的空狀態補完整', { delay: 55 });
  await beat(page, 900);
  await page.getByTestId('pal-compose').click();
  await beat(page, 1500);
});

test('attempt', async ({ page }) => {
  await boot(page);
  await card(page, '修好登入頁的白畫面', '登入後畫面全白,先重現再修。');
  await beat(page);
  // 開 attempt:組好的 prompt 攤在眼前,送出前還能改。
  await page.locator('[data-testid="task-k1"] button.primary').click();
  await beat(page, 1500);
  await page.getByTestId('attempt-start').click();
  // 真終端機:同一個 TUI,同一份鍵盤。
  await beat(page, 2000);
});

test('review', async ({ page }) => {
  await boot(page);
  await card(page, '修好登入頁的白畫面', '登入後畫面全白,先重現再修。');
  await page.locator('[data-testid="task-k1"] button.primary').click();
  await beat(page, 300);
  await page.getByTestId('attempt-start').click();
  await beat(page, 600);
  await page.evaluate(() => {
    window.__mock.diffs.set('k1-a1', [
      'diff --git a/src/auth.py b/src/auth.py',
      'index 1111111..2222222 100644',
      '--- a/src/auth.py',
      '+++ b/src/auth.py',
      '@@ -10,6 +10,8 @@ def login(request):',
      ' def login(request):',
      '     user = request.user',
      '-    return None',
      '+    session = make_session(user)',
      '+    return session',
      ' ',
      ' def logout(request):',
    ].join('\n'));
  });
  await page.getByTestId('view-board').click();
  await beat(page, 400);
  await page.getByTestId('inspect-k1').click();
  await beat(page, 1200);
  // 點一行 diff,留一句話,整批送回 agent —— 不用離開終端機旁邊。
  await page.locator('.diff-line.add').first().click();
  await beat(page, 600);
  await page.getByTestId('review-note').pressSequentially('session 可能是 undefined,回傳前先檢查', { delay: 45 });
  await beat(page, 700);
  await page.getByTestId('review-add').click();
  await beat(page, 1600);
});

test('knows', async ({ page }) => {
  await boot(page);
  await card(page, '重構 payments API', '把重複的錯誤處理收斂掉。');
  await page.locator('[data-testid="task-k1"] button.primary').click();
  await beat(page, 300);
  await page.getByTestId('attempt-start').click();
  await beat(page, 600);
  await page.getByTestId('view-board').click();
  await page.getByTestId('inspect-k1').click();
  await beat(page, 900);
  // 「它知道什麼」:agent 還沒被打字之前就已經讀過的東西 —— 不存在的也列。
  await page.getByTestId('inspector-knows-tab').click();
  await beat(page, 2200);
});

test('settings', async ({ page }) => {
  await boot(page);
  await beat(page, 500);
  await page.keyboard.press('ControlOrMeta+,');
  await beat(page, 1000);
  // 用畫面上叫什麼去找設定,而不是記得它在第幾層。
  await page.getByTestId('settings-search').pressSequentially('檢查點', { delay: 90 });
  await beat(page, 1100);
  await page.getByTestId('sec-sessions').click();
  await beat(page, 1800);
});
