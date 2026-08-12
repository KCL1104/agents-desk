// 版面不變式:在幾個真實視窗尺寸下,沒有任何東西被畫到別的東西上面。
//
// 起因是一張 README 截圖 —— 「進行中」欄的最後一張卡片壓在 ad-hoc 面板上。
// 病因不是卡片,是 `.board-cols` 上的一行 `min-height: 0`:它拿掉了 flex 子項
// 的 min-content 底線,於是那格網格被壓得比內容矮,而 grid 的 overflow 是
// visible,所以卡片照畫不誤 —— 畫到下面的面板上。1440x900 也中招,被壓掉 500px。
//
// 所以第一條檢查直接說出病因(網格不得比內容矮),而不是只驗證症狀:
// 症狀要卡片夠高才看得見,病因永遠看得見。
import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';
const SIZES = [[1280, 460], [1280, 520], [1280, 560], [1024, 640], [1280, 720], [1440, 900], [1920, 1080]] as const;

async function build(page: Page, w: number, h: number) {
  await page.addInitScript(installMock);
  await page.setViewportSize({ width: w, height: h });
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.getByTestId('view-board').click();
  // 併發調高,好讓一欄真的比板面高 —— 這正是那個溢出 bug 的條件。
  for (const t of ['修好登入頁在 Safari 的白畫面', '重構 payments API', '匯入工具', '寫文件', '第五張卡', '第六張卡']) {
    await page.getByRole('button', { name: '新增卡片', exact: true }).click();
    await page.getByTestId('task-prompt').fill('把它修好');
    await page.getByTestId('task-title').fill(t);
    await page.getByTestId('task-repo').fill(REPO);
    await page.getByTestId('task-branch').fill('main');
    await page.getByTestId('task-create').click();
  }
  for (let i = 0; i < 3; i++) await page.locator('[data-testid="concurrency"] button').last().click();
  for (const k of ['k1', 'k2', 'k3', 'k4', 'k5', 'k6']) {
    await page.locator(`[data-testid="task-${k}"] button.primary`).click();
    await page.getByTestId('attempt-start').click();
    await page.getByTestId('view-board').click();
  }
  await page.evaluate(() => {
    window.__mock.report('s1', 'running', { tool: 'Bash', detail: 'pytest tests/test_auth.py -v' });
    window.__mock.report('s2', 'waiting_permission');
    // 有 diffstat 的卡片更高 —— README 那張圖裡的卡片都帶著數字。
    window.__mock.stats.set('k2-a1', { adds: 342, dels: 57, ahead: 0, behind: 3 });
  });
  await page.waitForTimeout(400);
}

for (const [w, h] of SIZES) {
  test(`layout sweep ${w}x${h}`, async ({ page }) => {
    await build(page, w, h);
    const report = await page.evaluate(() => {
      const bad: string[] = [];
      const rect = (s: string) => document.querySelector(s)?.getBoundingClientRect() ?? null;

      // 1) 看板的欄位網格絕不能被壓得比它自己的內容矮。
      //    被壓的時候卡片不是被裁掉,是畫到下面的面板上。
      const cols = document.querySelector('.board-cols');
      if (cols && cols.scrollHeight > cols.clientHeight + 1) {
        bad.push(`board-cols squeezed: content ${cols.scrollHeight}px into ${cols.clientHeight}px`);
      }

      // 2) 卡片不得溢出自己的欄位 —— 欄位被壓扁時卡片會畫到欄外。
      for (const col of document.querySelectorAll('.board-col')) {
        const box = col.getBoundingClientRect();
        for (const c of col.querySelectorAll('.board-card')) {
          const b = c.getBoundingClientRect();
          if (b.bottom > box.bottom + 1) {
            bad.push(`card overflows its column by ${Math.round(b.bottom - box.bottom)}px`);
            break;
          }
        }
      }

      // 3) 整個頁面不該橫向捲動。
      if (document.body.scrollWidth > document.body.clientWidth + 1) {
        bad.push(`page scrolls sideways: ${document.body.scrollWidth} > ${document.body.clientWidth}`);
      }

      // 4) 側欄與主欄不得重疊。
      const side = rect('.sidebar'), main = rect('.main');
      if (side && main && side.right > main.left + 1) {
        bad.push(`sidebar overlaps main by ${Math.round(side.right - main.left)}px`);
      }

      // 5) 每張卡片一樣高。這一批卡片跨了佇列、執行中、等你、有 diffstat
      //    與沒有 diffstat —— 也就是各列會出現與消失的所有組合。它們高度
      //    相同,才證明那些列是被「保留」下來而不是有才長出來的。
      //    留 1px 給次像素捨入,不留第二像素:19px 的一列漏掉就會被抓到。
      const heights = [...document.querySelectorAll('.board-card')].map(
        (c) => Math.round(c.getBoundingClientRect().height),
      );
      if (heights.length > 1) {
        const lo = Math.min(...heights), hi = Math.max(...heights);
        if (hi - lo > 1) bad.push(`cards differ in height: ${lo}px … ${hi}px (${heights.join(', ')})`);
      }
      return bad;
    });
    console.log(`${w}x${h}: ${report.length === 0 ? 'clean' : JSON.stringify(report)}`);
    expect(report).toEqual([]);
  });
}
