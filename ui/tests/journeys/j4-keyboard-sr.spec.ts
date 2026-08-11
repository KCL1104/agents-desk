import { test, expect, type Page } from '@playwright/test';
import {
  REPO,
  attemptShape,
  cardShape,
  chord,
  coldStart,
  driveStatus,
  expectFocusWithin,
  sessionShape,
} from './helpers';

/**
 * J4 —— 無障礙契約之旅：整條 J1 的骨架（歡迎 → 建卡 → 開始 → 等你 →
 * 授權轉變 → 檢視 → 合併），全程只用鍵盤，全程 reducedMotion: reduce。
 *
 * 這一條是全套最嚴的一份：關鍵節點原則在這裡失效 —— **每一步**都驗
 * 三件事：(a) document.activeElement 真正在說好的元素裡，(b) 朗讀通道
 * （.visually-hidden 的 live region）說了什麼、逐字比對型錄的句子，
 * (c) 畫面換上了什麼 —— 且減速下靜態也要說真話：needs-you 卡片戴著
 * 凍結的琥珀環（box-shadow 在、animation 停），astir 卡片保留靜態的
 * accent 左緣。
 *
 * 另外釘住的 SR 契約：卡片群組的 aria-label 唸 標題＋狀態＋未讀，
 * 非 normal 權限模式也一起唸（liveLabel 的 withMode 路）；側欄列動作
 * 按鈕有真的可讀名字（不是 ✓ ✕ 字形）；分頁徽章的意義進得了分頁的
 * 可讀名字（今天的真話見該步驟）；splitter 與檢視器把手曝露
 * aria-valuenow 且方向鍵真的動它；世界選單開門即入焦、方向鍵走列、
 * Esc 還焦點給晶片；modal 焦點被關住（最後一個 Tab 迴繞）、關門還焦；
 * diff 的 <pre> 戴 aria-keyshortcuts，留言後（⌘Enter）漫遊焦點從
 * 走到的那行接著走，不是回到頭。
 */

// 整條旅程都在 prefers-reduced-motion: reduce 底下走 —— 這個版本的
// Playwright 把模擬收進 contextOptions。
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const FIRST_LINE = '修好結帳頁的白畫面';

/**
 * 用同一個 DataTransfer 派發整串 HTML5 拖放事件，把 s95 的 pane 拖到
 * s1 的右緣做出手排切分 —— splitter 只活在手排佈局裡，而鍵盤造不出
 * 切分（拖是那個手勢）；這裡是佈景，受測的是 separator 的鍵盤契約。
 * 抄自 layout.spec 的做法；helpers.ts 沒有這件工具（見報告 deferred）。
 */
async function dragSplit(page: Page, fromSel: string, toSel: string): Promise<void> {
  await page.evaluate(
    ({ fromSel, toSel }) => {
      const src = document.querySelector(fromSel);
      const dst = document.querySelector(toSel);
      if (!src || !dst) throw new Error(`drag endpoints missing: ${fromSel} → ${toSel}`);
      const dt = new DataTransfer();
      src.dispatchEvent(
        new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
      const r = dst.getBoundingClientRect();
      // 右緣 95%:pane 的 drop 分區依落點座標決定 split 方向。
      const x = r.x + r.width * 0.95;
      const y = r.y + r.height / 2;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        dst.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: x,
            clientY: y,
          }),
        );
      }
      src.dispatchEvent(
        new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    },
    { fromSel, toSel },
  );
}

/** 焦點掉回 <body> —— 幾個「今天的真話」節點共用的斷言。 */
async function expectFocusOnBody(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.activeElement === document.body), {
      message: 'focus should have fallen back to <body>',
    })
    .toBe(true);
}

test('J4 · the accessibility contract, end to end under reduced motion', async ({ page }) => {
  // 章節多、全程逐節點三重驗證;120s 是餘裕不是等待 —— 每一步仍靠
  // expect 輪詢,絕不 sleep。
  test.setTimeout(120_000);

  const live = page.getByTestId('live-announce');
  const card = page.getByTestId('task-k1');
  const door = page.locator('[data-testid="task-k1"] .card-door');

  // 手排切分需要兩個 pane 並排都放得下最小寬 —— layout.spec 的同一個
  // 視窗尺寸,開場就定好,旅程中途不再變形。
  await page.setViewportSize({ width: 1400, height: 900 });

  await test.step('1. cold start — the welcome dialog holds focus, and the trap wraps', async () => {
    await coldStart(page);
    await expect(page.locator('.sidebar')).toBeVisible();

    // (c) 歡迎面板浮著。
    const modal = page.locator('.modal');
    await expect(modal).toContainText('歡迎使用 Marol');

    // (b) 朗讀通道的底座:.visually-hidden、polite、此刻無話。
    await expect(live).toHaveClass(/visually-hidden/);
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('');

    // (a) 焦點真的在對話框裡,而且落在第一個控件(關閉)上。
    await expectFocusWithin(page, '.modal');
    const close = modal.getByRole('button', { name: '關閉', exact: true });
    await expect(close).toBeFocused();

    // modal 的焦點陷阱:Tab 走完三顆按鈕後迴繞,Shift+Tab 反向迴繞 ——
    // 障蔽後面的看板一步都進不去。
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('welcome-session')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('welcome-card')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByTestId('welcome-card')).toBeFocused();
  });

  await test.step('2. Enter on 開第一張卡 — the new-card dialog takes the caret', async () => {
    // 焦點已在「開第一張卡」上(上一步的反向迴繞停在這),Enter 就是門。
    await page.keyboard.press('Enter');

    // (c) 腳下已是看板,新卡對話框開著。
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.locator('.modal h2')).toHaveText('新卡片');
    // (a) 開門即可打字:焦點在目標欄 —— 標題是選填而且由 prompt 推導。
    await expect(page.getByTestId('task-prompt')).toBeFocused();
    // (b) 開一扇對話框不是要朗讀的事。
    await expect(live).toHaveText('');
  });

  await test.step('3. the card is created by keyboard alone, and spoken', async () => {
    await page
      .getByTestId('task-prompt')
      .fill(`${FIRST_LINE}\n\n結帳後整頁變白,console 乾淨。先重現再修。`);
    await page.getByTestId('task-repo').fill(REPO);
    await page.getByTestId('task-branch').fill('main');

    // 多行欄位裡 Enter 是換行;送出走 ⌘/Ctrl+Enter。
    await page.getByTestId('task-prompt').focus();
    await chord(page, 'Enter');

    // (c) 對話框關了,backlog 收下第一張卡,標題是 prompt 的第一行。
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('[data-testid="col-backlog"] .board-card')).toHaveCount(1);
    await expect(page.locator('[data-testid="task-k1"] .board-card-title')).toHaveText(
      FIRST_LINE,
    );
    // (a) 焦點落在新卡片上。
    await expect(card).toBeFocused();
    // (b) 建立被逐字說出:AT 只聽得到落點,原因得靠這一句。
    await expect(live).toHaveText(`已建立卡片：「${FIRST_LINE}」`);
  });

  await test.step('4. the start dialog: focus dives in, Escape gives it back', async () => {
    // 剛聚焦的卡片,Tab 一下就是「開始」。
    await page.keyboard.press('Tab');
    const start = page.locator('[data-testid="task-k1"] button.primary');
    await expect(start).toBeFocused();
    await expect(start).toHaveText('開始');

    // 開門:焦點進對話框,落在第一個控件(agent 選單)。
    await page.keyboard.press('Enter');
    await expect(page.locator('.modal h2')).toHaveText(`開始 attempt：${FIRST_LINE}`);
    await expectFocusWithin(page, '.modal');
    await expect(page.getByTestId('attempt-agent')).toBeFocused();

    // 關門還焦:Escape 收起對話框,焦點回到開它的那顆「開始」上 ——
    // modal 契約的另一半,陷阱在第 1 步已釘。
    await page.keyboard.press('Escape');
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(start).toBeFocused();
    // (b) 開合對話框,通道自始至終不插話。
    await expect(live).not.toContainText('attempt');

    // 再進去,這次走到底。預設值就是契約:claude、照常詢問。
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('attempt-agent')).toBeFocused();
    await expect(page.getByTestId('attempt-agent')).toHaveValue('claude');
    // 權限模式戴著可見的 label,而且真的連上了(getByLabel 找得到)。
    await expect(page.getByLabel('權限模式')).toHaveValue('normal');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('attempt-mode')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('attempt-prompt')).toBeFocused();
    await expect(page.getByTestId('attempt-prompt')).toHaveValue(
      new RegExp(`Marol 任務.*${FIRST_LINE}`, 's'),
    );
    // ⌘/Ctrl+Enter 送出 —— 與 review 撰寫框同一個慣例。
    await chord(page, 'Enter');
  });

  await test.step('5. the terminal takes the caret; the trust gate is spoken verbatim', async () => {
    // (c) 對話框讓位,pane 上了牆。
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    // (a) 插入點真的在終端裡。
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');
    // (b) 出生就停在信任門上,整句逐字:標題＋狀態。
    await expect(live).toHaveText(`${FIRST_LINE} #1 等你確認資料夾`);

    // 第一次開 attempt 的 coach 出現,但一毫米焦點都不偷。
    await expect(page.getByTestId('coach-attempt')).toBeVisible();
    await expect(page.getByTestId('coach-attempt')).toContainText('worktree');
    expect(
      await page.evaluate(
        () => document.querySelector('.coach')?.contains(document.activeElement) ?? false,
      ),
    ).toBe(false);

    // 用鍵盤收下教學;coach 卸下後沒有安排落點 —— 焦點掉回 <body>,
    // 這是 app 今天的真話,釘在這裡,改了會被看見。
    await page.getByTestId('coach-dismiss').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('coach-attempt')).toHaveCount(0);
    await expectFocusOnBody(page);
  });

  await test.step('6. ⌘2 — reduced motion still tells the truth: the frozen amber ring', async () => {
    await chord(page, '2');
    // (c) 看板上場;(a) 視圖切換不安排落點,焦點在 <body>(今天的真話)。
    await expect(page.getByTestId('board')).toBeVisible();
    await expectFocusOnBody(page);
    // (b) 導航不朗讀。
    await expect(live).not.toContainText('看板');

    // 卡片戴著信任門:視覺是 needs-you,朗讀是完整一句 標題＋需要你＋狀態。
    await expect(card).toHaveClass(/needs-you/);
    await expect(page.getByTestId('state-k1')).toContainText('等你確認資料夾');
    await expect(card).toHaveAttribute(
      'aria-label',
      `${FIRST_LINE}，需要你，等你確認資料夾`,
    );

    // 減速的靜態真話:呼吸停了(animation: none),琥珀環卻凍在原地 ——
    // box-shadow 帶著 0 0 0 2px 的外環,不是 bevel 而已。
    const ring = await card.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { animation: cs.animationName, shadow: cs.boxShadow };
    });
    expect(ring.animation).toBe('none');
    expect(ring.shadow).toMatch(/0px 0px 0px 2px/);
  });

  await test.step('7. a seeded yolo attempt — the aria-label speaks the mode', async () => {
    // 種一張 yolo 卡:liveLabel 的 withMode 路 —— ⚡ 徽章對 AT 是啞的,
    // 「這個 session 少問你」必須進 aria-label。
    const task = cardShape(90, {
      title: '背景重構',
      lifecycle: 'running',
      position: 1,
      attempts: [
        attemptShape('k90', 1, {
          mode: 'yolo',
          session_id: 's95',
          worktree_path: '/Users/test/worktrees/card-90',
        }),
      ],
    });
    const session = sessionShape('s95', {
      status: 'running',
      attempt_id: 'k90-a1',
      title: '背景重構 #1',
      cwd: '/Users/test/worktrees/card-90',
    });
    await page.evaluate(
      (seed) => {
        window.__mock.tasks.push(seed.task);
        window.__mock.sessions.push(seed.session);
        window.__mock.pushSessions();
        window.__mock.pushTasks();
      },
      { task, session },
    );

    // (c) 卡片在進行中欄,戴著 ⚡ 徽章;(b) 群組標籤逐字:標題＋狀態＋模式。
    const yolo = page.getByTestId('task-k90');
    await expect(
      page.locator('[data-testid="col-running"] [data-testid="task-k90"]'),
    ).toBeVisible();
    await expect(page.getByTestId('mode-k90')).toBeVisible();
    await expect(yolo).toHaveAttribute('role', 'group');
    await expect(yolo).toHaveAttribute('aria-label', '背景重構，執行中，全自動（yolo）');

    // 減速下 astir 的靜態真話:微光不閃(animation: none),但 accent
    // 左緣留著 —— 「活著」這件事靜態也讀得出來。
    const edge = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="task-k90"]')!;
      const probe = document.createElement('span');
      probe.style.color = 'var(--accent)';
      document.body.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const cs = getComputedStyle(el);
      return { animation: cs.animationName, edge: cs.borderLeftColor, accent };
    });
    expect(edge.animation).toBe('none');
    expect(edge.edge).toBe(edge.accent);
    await expect(yolo).toHaveClass(/astir/);

    // 側欄列同一套文法:group、標籤 標題＋狀態;動作按鈕有真名字,
    // 不是 ✓ 與 ✕ 的字形。
    const row = page.getByTestId('session-s95');
    await expect(row).toHaveAttribute('role', 'group');
    await expect(row).toHaveAttribute('aria-label', '背景重構 #1，執行中');
    await expect(row.locator('.row-action').nth(0)).toHaveAccessibleName('標記為完成');
    await expect(row.locator('.row-action').nth(1)).toHaveAccessibleName('關閉終端機');

    // (b) 一個跑著的 session 不是要朗讀的事;(a) 焦點仍在 <body>。
    await expect(live).not.toContainText('背景重構');
    await expectFocusOnBody(page);
  });

  await test.step('8. working → waiting: three surfaces light, nothing steals focus', async () => {
    // 把焦點放上卡片的門:接下來的每一次狀態轉變都不准動它。
    await door.focus();
    await expect(door).toBeFocused();

    // 信任答完,agent 動起來:k1 也換上靜態的 astir 左緣。
    await driveStatus(page, 's1', 'running');
    await expect(card).toHaveClass(/astir/);
    await expect(page.getByTestId('state-k1')).toContainText('執行中');
    const astir = await card.evaluate((el) => getComputedStyle(el).animationName);
    expect(astir).toBe('none');
    await expect(door).toBeFocused();

    // 在做 → 等你:琥珀時刻,三個表面同時亮,朗讀逐字,焦點原地。
    await driveStatus(page, 's1', 'waiting_permission');
    // (c-1) 卡片:呼吸位(減速下仍是凍結環),aria-label 整句換新。
    await expect(card).toHaveClass(/needs-you/);
    await expect(card).not.toHaveClass(/astir/);
    await expect(page.getByTestId('state-k1')).toContainText('等你授權');
    await expect(card).toHaveAttribute('aria-label', `${FIRST_LINE}，需要你，等你授權`);
    const ring = await card.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { animation: cs.animationName, shadow: cs.boxShadow };
    });
    expect(ring.animation).toBe('none');
    expect(ring.shadow).toMatch(/0px 0px 0px 2px/);
    // (c-2) 側欄:等你分區收下這列,琥珀橫幅逐字計 1。
    await expect(
      page.locator('[data-section="waiting"] [data-testid="session-s1"]'),
    ).toBeVisible();
    await expect(page.locator('.waiting-banner')).toHaveText('⚠ 1 個等你');
    // (c-3) 分頁徽章:blocked 壓過一切(s95 還在跑,busy 讓位)。
    await expect(page.locator('.tab-badge.waiting')).toHaveText('1');
    // 分頁的可讀名字:徽章的「數字」進了名字,但「意義」(等你處理)
    // 只掛在徽章的 title 上 —— AT 聽到的是光禿禿的「工作區 1」,不知道
    // 1 是等你、未讀還是在忙。真缺口,已記錄在報告裡;逐字釘住今天的
    // 真話,名字改善時這行會被看見。
    await expect(page.locator('[data-testid="tab-t1"]')).toHaveAccessibleName('工作區 1');
    // (b) 朗讀逐字。
    await expect(live).toHaveText(`${FIRST_LINE} #1 等你授權`);
    // 第一次「在做轉等你」的 coach:教琥珀,不偷焦點。
    await expect(page.getByTestId('coach-waiting')).toBeVisible();
    await expect(page.getByTestId('coach-waiting')).toContainText('琥珀');
    // (a) 三個表面亮起、coach 上場,焦點一步都沒被偷。
    await expect(door).toBeFocused();

    await page.getByTestId('coach-dismiss').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('coach-waiting')).toHaveCount(0);
  });

  await test.step('9. ⌘E — the jump lands the caret in the waiting terminal', async () => {
    await chord(page, 'e');
    // (c) 看板讓位,等你的 pane 上前;(a) 插入點真的在它的終端裡。
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');
    // (b) 跳轉不朗讀。
    await expect(live).not.toContainText('終端機');

    // 第一次插入點落進 pane 的 coach(真終端、Ctrl+字母屬於 shell),
    // 照樣不偷焦點,照樣鍵盤收下。
    await expect(page.getByTestId('coach-terminal')).toBeVisible();
    await expect(page.getByTestId('coach-terminal')).toContainText('真終端');
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');
    await page.getByTestId('coach-dismiss').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('coach-terminal')).toHaveCount(0);
  });

  await test.step('10. the splitter: aria-valuenow moves when the arrows do', async () => {
    // 第二個 pane 上牆 —— 側欄列的門是真按鈕,Enter 就進。
    await page.locator('[data-testid="session-s95"] .row-door').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.pane[data-session-id="s95"]')).toBeVisible();
    await expectFocusWithin(page, '.pane[data-session-id="s95"] .term-host');

    // 拖出手排切分(佈景;splitter 只活在手排佈局裡)。
    await dragSplit(page, '[data-testid="pane-s95"] .pane-head', '[data-testid="pane-s1"]');
    const splitter = page.locator('.splitter.row');
    await expect(splitter).toHaveCount(1);

    // separator 的承諾書:方向、範圍、目前值 —— 對半就是 50。
    await expect(splitter).toHaveAttribute('role', 'separator');
    await expect(splitter).toHaveAttribute('aria-orientation', 'vertical');
    await expect(splitter).toHaveAttribute('aria-valuemin', '0');
    await expect(splitter).toHaveAttribute('aria-valuemax', '100');
    await expect(splitter).toHaveAttribute('aria-valuenow', '50');

    // 承諾要兌現:聚焦後方向鍵真的動它,aria-valuenow 跟著長。
    await splitter.focus();
    await expect(splitter).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () => Number(await splitter.getAttribute('aria-valuenow')))
      .toBeGreaterThan(50);
    // (b) 調整佈局不朗讀。
    await expect(live).not.toContainText('分隔');
  });

  await test.step('11. the turn ends off-screen: the unseen grammar, spoken once', async () => {
    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    await expectFocusOnBody(page);

    await door.focus();

    // 你授權了,agent 繼續做:等待的表面全部退場。
    await driveStatus(page, 's1', 'running');
    await expect(page.locator('.waiting-banner')).toHaveCount(0);
    await expect(page.locator('.tab-badge.waiting')).toHaveCount(0);
    await expect(door).toBeFocused();

    // 回合在看板前結束 —— 未讀文法三處同亮,標籤與朗讀逐字。
    await driveStatus(page, 's1', 'idle');
    await expect(page.getByTestId('unseen-s1')).toBeVisible();
    await expect(page.getByTestId('unseen-card-k1')).toBeVisible();
    await expect(page.locator('.tab-badge.unseen')).toHaveText('1');
    // 卡片與側欄列的 aria-label 都把「已完成,還沒看過」唸進去。
    await expect(card).toHaveAttribute(
      'aria-label',
      `${FIRST_LINE}，待命，已完成，還沒看過`,
    );
    await expect(page.getByTestId('session-s1')).toHaveAttribute(
      'aria-label',
      `${FIRST_LINE} #1，待命，已完成，還沒看過`,
    );
    // (a) 狀態轉變仍不動焦點;(b) 回合結束逐字。
    await expect(door).toBeFocused();
    await expect(live).toHaveText(`「${FIRST_LINE} #1」回合結束`);
  });

  await test.step('12. the world menu: focus dives in, arrows walk, Escape returns', async () => {
    const chip = page.getByTestId('world-chip');
    await expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    await expect(chip).toHaveAttribute('aria-expanded', 'false');

    await chip.focus();
    await page.keyboard.press('Enter');

    // (c) 選單開了;(a) 焦點進門,落在目前生效的那列(本機)。
    const menu = page.getByTestId('world-menu');
    await expect(menu).toBeVisible();
    await expect(chip).toHaveAttribute('aria-expanded', 'true');
    const local = page.getByTestId('world-local');
    await expect(local).toBeFocused();
    await expect(local).toHaveAttribute('role', 'menuitemradio');
    await expect(local).toHaveAttribute('aria-checked', 'true');
    // 列不進 Tab 序:焦點由方向鍵漫遊。
    await expect(local).toHaveAttribute('tabindex', '-1');

    // 方向鍵走列:WSL distro、SSH host,到底再迴繞。
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('world-wsl-Ubuntu')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('world-ssh-devbox')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(local).toBeFocused();

    // Escape 關門,焦點還給晶片。
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(chip).toBeFocused();
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    // (b) 開合選單不朗讀。
    await expect(live).not.toContainText('本機');
  });

  await test.step('13. walking in reads it; ⌘⇧I lands in the diff; the grip keeps its promise', async () => {
    await door.focus();
    await page.keyboard.press('Enter');
    // (c) 進門看它:未讀文法整組退場,徽章讓位給 busy(s95 還在跑)。
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');
    await expect(page.getByTestId('unseen-s1')).toHaveCount(0);
    await expect(page.getByTestId('unseen-card-k1')).toHaveCount(0);
    await expect(page.locator('.tab-badge.unseen')).toHaveCount(0);
    await expect(page.locator('.tab-badge.busy')).toBeVisible();

    // worktree 裡有活可看了。
    await page.evaluate(() => {
      window.__mock.diffs.set(
        'k1-a1',
        [
          'diff --git a/src/checkout.py b/src/checkout.py',
          '--- a/src/checkout.py',
          '+++ b/src/checkout.py',
          '@@ -10,3 +10,4 @@',
          ' def checkout(cart):',
          '+    order = make_order(cart)',
          '+    return order',
        ].join('\n'),
      );
    });

    // 插入點在終端裡,所以是 Shift 變體。
    await chord(page, 'I', { shift: true });
    // (c) 檢視器開在終端旁;(a) 和弦自己走完旅程,焦點落在 diff 本體。
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('diff-body')).toBeFocused();
    // (b) 開檢視器不朗讀。
    await expect(live).not.toContainText('檢視');
    // <pre> 把自己的鍵盤說出來 —— SR 使用者不用猜 j/k。
    await expect(page.getByTestId('diff-body')).toHaveAttribute(
      'aria-keyshortcuts',
      'j k n p e v Enter',
    );

    // 第一次見到 Finish 腳注的 coach(結束是最終的),照樣不偷焦點。
    await expect(page.getByTestId('coach-finish')).toBeVisible();
    await expect(page.getByTestId('diff-body')).toBeFocused();
    await page.getByTestId('coach-dismiss').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('coach-finish')).toHaveCount(0);

    // 檢視器把手:separator 曝露範圍與現值(預設寬 460 → 21%),
    // ← 加寬、→ 收窄,數字跟著動。
    const grip = page.getByTestId('inspector-grip');
    await expect(grip).toHaveAttribute('role', 'separator');
    await expect(grip).toHaveAttribute('aria-orientation', 'vertical');
    await expect(grip).toHaveAttribute('aria-valuemin', '0');
    await expect(grip).toHaveAttribute('aria-valuemax', '100');
    await expect(grip).toHaveAttribute('aria-valuenow', '21');
    await expect(grip).toHaveAccessibleName('拖曳調整寬度；← 加寬、→ 收窄');
    await grip.focus();
    await expect(grip).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(grip).toHaveAttribute('aria-valuenow', '26');
    await page.keyboard.press('ArrowRight');
    await expect(grip).toHaveAttribute('aria-valuenow', '21');
  });

  await test.step('14. j/k rove; a comment via ⌘Enter; the walk resumes where it stood', async () => {
    const body = page.getByTestId('diff-body');
    await body.focus();
    await expect(body).toBeFocused();

    // 漫遊焦點:行是 j/k 的停靠點,永遠不是 Tab 的 —— 300 行的 diff
    // 不准變成合併鍵前的 300 個 Tab 站。
    const lines = page.locator('.diff-line.commentable');
    await expect(lines.first()).toHaveAttribute('tabindex', '-1');

    await page.keyboard.press('j');
    await expect(lines.first()).toBeFocused();
    await page.keyboard.press('j');
    await expect(lines.nth(1)).toBeFocused();

    // Enter 對準第二行留話:撰寫框借走插入點。
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('review-note')).toBeFocused();
    await page.getByTestId('review-note').fill('先驗證 cart 再開 order');
    // ⌘Enter 收進批次:焦點還給 diff 本體 ——
    await chord(page, 'Enter');
    await expect(page.getByTestId('review-pending')).toContainText('先驗證 cart 再開 order');
    await expect(body).toBeFocused();
    // —— 而且下一個 j 從走到的那行(第二行)接著走,不是回到頭。
    await page.keyboard.press('j');
    await expect(lines.nth(1)).toBeFocused();
    await page.keyboard.press('k');
    await expect(lines.first()).toBeFocused();

    // 一批一則,整包送回 session 自己的終端 —— 按鈕有真名字。
    const send = page.getByTestId('review-send');
    await expect(send).toHaveText('把 1 則意見送回給 agent');
    await send.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('review-pending')).toHaveCount(0);
    // 真的送出去了:訊息以 prompt 之姿落在 attempt 的時間線上。
    expect(
      await page.evaluate(() =>
        (window.__mock.events.get('k1-a1') ?? []).some(
          (e) => e.kind === 'prompt' && (e.detail ?? '').includes('先驗證 cart'),
        ),
      ),
    ).toBe(true);
  });

  await test.step('15. merge arms in place, lands, and the board says 已合併', async () => {
    // 合併武裝制:第一下 Enter 只換名字,焦點原地不動,第二下才開火。
    const merge = page.getByTestId('merge-attempt');
    await expect(merge).toHaveText('合併回 main');
    await merge.focus();
    await page.keyboard.press('Enter');
    const armed = page.getByTestId('confirm-merge');
    await expect(armed).toHaveText('確定合併回 main？');
    await expect(armed).toBeFocused();
    await page.keyboard.press('Enter');

    // (c) toast 確認落地;抽屜與 s1 的 pane 一起收回,s95 還在。
    await expect(page.locator('.toast.ok')).toContainText('已合併回 main');
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s1"]')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s95"]')).toBeVisible();
    // (a) J1 在空牆上釘過「焦點退回 <body>」;這裡牆上還有 s95 ——
    // focusedId 落回 members[0],倖存的 pane 接走插入點。比掉到 body
    // 好的真話,一樣釘住:改了會被看見。
    await expectFocusWithin(page, '.pane[data-session-id="s95"] .term-host');
    // (b) 合併走 toast,不走朗讀通道 —— 今天的真話。
    await expect(live).not.toContainText('合併');

    // 回看板:贏了的卡片,標籤只剩 標題＋結局。
    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(card).toHaveAttribute('data-outcome', 'merged');
    await expect(page.getByTestId('state-k1')).toContainText('已合併');
    await expect(card).toHaveAttribute('aria-label', `${FIRST_LINE}，已合併`);
    // 通道的底座自始至終沒變形。
    await expect(live).toHaveAttribute('aria-live', 'polite');
  });
});
