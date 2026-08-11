// 全面 UI 稽核:走過每個表面,在每個尺寸下找「畫出去了」的東西。
//
// 核心檢查是那個看板 bug 的一般化:一個 overflow 為 visible 的元素,
// 它的內容比它自己高或寬 —— 那不是裁切,是畫到別人身上。
// SHOT_DIR 有設時順便留圖,方便用眼睛複驗。
import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';
const SIZES = [[1280, 720], [1440, 900], [1920, 1080]] as const;

interface Finding { surface: string; size: string; what: string }

async function scan(page: Page, surface: string, size: string): Promise<Finding[]> {
  const raw = await page.evaluate(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    const name = (el: Element) => {
      const c = (el.className && typeof el.className === 'string' ? el.className : '').split(' ')[0];
      const t = el.getAttribute('data-testid');
      return `${el.tagName.toLowerCase()}${c ? '.' + c : ''}${t ? `[${t}]` : ''}`;
    };
    // xterm 的內部 DOM 不是我們畫的,而且它自己管捲動。
    const foreign = (el: Element) =>
      el.closest('.xterm, .term-host') !== null || el.tagName === 'CANVAS';
    // 祖先會不會捲它。注意:這對「垂直」不是免罪符 —— 一個被壓扁的
    // flex 子項,它後面的兄弟會被排到它的盒子底下,然後被內容蓋住;
    // 祖先捲不捲都一樣。所以垂直看的是「後面還有沒有人會被蓋到」。
    const handled = (el: Element, axis: 'y' | 'x') => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        const o = getComputedStyle(p)[axis === 'y' ? 'overflowY' : 'overflowX'];
        if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      if (foreign(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const push = (key: string, msg: string) => {
        if (seen.has(key)) return;
        seen.add(key);
        out.push(msg);
      };
      const vOver = el.scrollHeight - el.clientHeight;
      if (vOver > 2 && cs.overflowY === 'visible' && el.children.length > 0 && el.nextElementSibling) {
        push(`v:${name(el)}`, `${name(el)} is ${vOver}px shorter than its content, with a sibling below it to be drawn over`);
      }
      const hOver = el.scrollWidth - el.clientWidth;
      if (hOver > 2 && cs.overflowX === 'visible' && el.children.length > 0 && !handled(el, 'x')) {
        push(`h:${name(el)}`, `${name(el)} overflows right by ${hOver}px, and nothing scrolls it`);
      }
      if (el.tagName === 'BUTTON' && (r.width < 18 || r.height < 18)) {
        push(`hit:${name(el)}`, `${name(el)} hit target ${Math.round(r.width)}x${Math.round(r.height)} < 18`);
      }
      if ((r.right > innerWidth + 2 || r.bottom > innerHeight + 2 || r.left < -2) && !handled(el, 'y') && !handled(el, 'x')) {
        push(`oob:${name(el)}`, `${name(el)} is drawn outside the viewport`);
      }
    }
    if (document.body.scrollWidth > document.body.clientWidth + 1) out.push('the page scrolls sideways');
    return out;
  });

  return raw.map((what) => ({ surface, size, what }));
}

async function seed(page: Page) {
  await page.getByTestId('view-board').click();
  for (const t of ['修好登入頁在 Safari 的白畫面', '重構 payments API', '匯入工具', '寫 onboarding 文件']) {
    await page.getByRole('button', { name: '新增卡片', exact: true }).click();
    await page.getByTestId('task-prompt').fill('把它修好,先重現再改。');
    await page.getByTestId('task-title').fill(t);
    await page.getByTestId('task-repo').fill(REPO);
    await page.getByTestId('task-branch').fill('main');
    await page.getByTestId('task-create').click();
  }
  for (const k of ['k1', 'k2', 'k3']) {
    await page.locator(`[data-testid="task-${k}"] button.primary`).click();
    await page.getByTestId('attempt-start').click();
    await page.getByTestId('view-board').click();
  }
  await page.evaluate(() => {
    window.__mock.report('s1', 'running', { tool: 'Bash', detail: 'pytest tests/test_auth.py -v' });
    window.__mock.report('s2', 'waiting_permission');
    window.__mock.stats.set('k2-a1', { adds: 342, dels: 57, ahead: 0, behind: 3 });
    window.__mock.diffs.set('k1-a1', [
      'diff --git a/src/auth.py b/src/auth.py',
      'index 1111111..2222222 100644',
      '--- a/src/auth.py',
      '+++ b/src/auth.py',
      '@@ -10,6 +10,8 @@ def login():',
      ' def login(request):',
      '-    return None',
      '+    session = make_session(user)',
      '+    return session',
    ].join('\n'));
  });
  await page.waitForTimeout(300);
}

for (const [w, h] of SIZES) {
  test(`audit ${w}x${h}`, async ({ page }) => {
    await page.addInitScript(installMock);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await expect(page.locator('.tab')).toHaveCount(1);
    await seed(page);
    const size = `${w}x${h}`;
    const found: Finding[] = [];

    found.push(...(await scan(page, 'board', size)));

    await page.keyboard.press('ControlOrMeta+3');
    await page.waitForTimeout(200);
    found.push(...(await scan(page, 'overview', size)));

    await page.keyboard.press('ControlOrMeta+1');
    await page.waitForTimeout(300);
    found.push(...(await scan(page, 'terminal wall', size)));

    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await page.waitForTimeout(300);
    found.push(...(await scan(page, 'inspector · changes', size)));
    await page.getByTestId('inspector-timeline-tab').click();
    await page.waitForTimeout(200);
    found.push(...(await scan(page, 'inspector · activity', size)));
    await page.getByTestId('inspector-knows-tab').click();
    await page.waitForTimeout(300);
    found.push(...(await scan(page, 'inspector · knows', size)));
    await page.getByRole('button', { name: '關閉檢視' }).click();

    await page.keyboard.press('ControlOrMeta+,');
    for (const s of ['general', 'sessions', 'terminal', 'notifications', 'agents', 'diagnostics', 'advanced']) {
      await page.getByTestId(`sec-${s}`).click();
      await page.waitForTimeout(150);
      found.push(...(await scan(page, `settings · ${s}`, size)));
    }
    await page.keyboard.press('Escape');

    await page.keyboard.press('ControlOrMeta+/');
    await page.waitForTimeout(200);
    found.push(...(await scan(page, 'shortcuts', size)));
    await page.keyboard.press('Escape');

    await page.keyboard.press('ControlOrMeta+K');
    await page.getByTestId('palette-input').fill('修');
    await page.waitForTimeout(200);
    found.push(...(await scan(page, 'palette', size)));
    await page.keyboard.press('Escape');

    await page.getByTestId('view-board').click();
    await page.getByRole('button', { name: '新增卡片', exact: true }).click();
    await page.waitForTimeout(200);
    found.push(...(await scan(page, 'new card dialog', size)));
    await page.keyboard.press('Escape');

    await page.locator('[data-testid="task-k4"] button.primary').click();
    await page.waitForTimeout(200);
    found.push(...(await scan(page, 'start attempt dialog', size)));
    await page.keyboard.press('Escape');

    for (const f of found) console.log(`${f.size} · ${f.surface} · ${f.what}`);
    console.log(`${size} TOTAL ${found.length}`);
  });
}
