import { test, expect, type Page } from '@playwright/test';
import {
  attemptShape,
  boot,
  cardShape,
  chord,
  driveStatus,
  expectAnnounce,
  expectFocusNeutral,
  expectFocusWithin,
  seedDesk,
  sessionShape,
} from './helpers';

/**
 * J2 —— 平行分流：重度使用者的一天，五張卡同時在桌上。
 *
 * 2 個 session 等你（一個等授權、一個等回覆）、2 個在做（微光）、
 * 1 張停著的卡（idle：attempt 開著、終端沒掛著）。一條不換手的路：
 * 開場看牆與看板 → ⌘K 空查詢的注意力收件匣 → ⌘E 逐一跳到等你的
 * session、答完徽章遞減 → 回合趁你不在時結束（未讀文法）→ 用面板的
 * 新橋把焦點交到停著的卡、鍵盤合併它 → 停一張已安定的卡（單擊、
 * 不武裝）。全程零滑鼠：沒有一個 .click()。
 *
 * 與 J1 同一套斷言紀律：每個關鍵節點（對話框開合、視圖切換、狀態
 * 轉變）驗三件事 —— (a) 焦點真正落在哪（document.activeElement）、
 * (b) 朗讀通道說了什麼（live-announce）、(c) 畫面換上了什麼。節點
 * 之間用普通可見性斷言接。
 */

/** 五張卡的名字 —— 斷言與朗讀都指名道姓，常數收在一處。 */
const T1 = '修權限漏洞';
const T2 = '補登入表單測試';
const T3 = '重構通知模組';
const T4 = '快取伺服回應';
const T5 = '整理 README';

/**
 * 把牆的格局種進 mock 的分頁鍵。
 *
 * 分頁徽章只數自己 slots 裡的 session（TabStrip 由 slots 取 shown），
 * 所以「徽章計 2」的契約要求種子先把活著的 session 排上牆。helpers
 * 沒有這支種法（見報告 deferred）—— 與 seedDesk 同一條規矩：必須在
 * boot 之前呼叫，installMock 建構當下就讀 __mockTabs。
 */
async function seedWall(page: Page, slots: string[]): Promise<void> {
  await page.addInitScript((s: string[]) => {
    sessionStorage.setItem(
      '__mockTabs',
      JSON.stringify([
        {
          id: 't1',
          name: '工作區',
          layout: '{"mode":"auto","cols":"auto"}',
          slots: s,
          position: 0,
        },
      ]),
    );
  }, slots);
}

/** 這一刻 row 被畫在哪個分區 —— sidebar.spec 的 sectionOf，本檔自備
 *  （helpers 沒有；journey 只在一處用到，見報告 deferred）。 */
async function sectionOf(page: Page, id: string): Promise<string | null> {
  return page
    .locator(`[data-testid="session-${id}"]`)
    .evaluate((el) => el.closest('.section')?.getAttribute('data-section') ?? null);
}

test('J2 · parallel triage, end to end', async ({ page }) => {
  // 章節多、途中還有 2.5s 的 settle 窗與 5s 的朗讀自清要等 ——
  // 90s 是餘裕不是等待，每一步仍靠 expect 輪詢，絕不 sleep。
  test.setTimeout(90_000);

  const live = page.getByTestId('live-announce');

  // 五張卡都在進行中欄；k1/k2 等你、k3/k4 在做、k5 的 attempt 開著
  // 但終端沒掛著（live:false）—— 這正是重啟後每張安定卡的樣子，也是
  // 面板那座「新橋」唯一會走的形狀（有活終端的卡直接進 session）。
  // worktree 各給各的路（預設全是 card-1 會讓 park 連坐拖走別人的
  // session —— mock 按 cwd 前綴收工作樹）。
  await seedDesk(page, {
    tasks: [T1, T2, T3, T4, T5].map((title, i) => {
      const n = i + 1;
      return cardShape(n, {
        title,
        lifecycle: 'running',
        attempts: [
          attemptShape(`k${n}`, 1, {
            session_id: `s9${n}`,
            worktree_path: `/Users/test/worktrees/k${n}-a1`,
            branch: `agentdesk/k${n}`,
          }),
        ],
      });
    }),
    sessions: [
      sessionShape('s91', {
        status: 'waiting_permission',
        attempt_id: 'k1-a1',
        title: `${T1} #1`,
        cwd: '/Users/test/worktrees/k1-a1',
        last_active_at: 5000,
      }),
      sessionShape('s92', {
        status: 'waiting_input',
        attempt_id: 'k2-a1',
        title: `${T2} #1`,
        cwd: '/Users/test/worktrees/k2-a1',
        last_active_at: 4000,
      }),
      sessionShape('s93', {
        status: 'running',
        attempt_id: 'k3-a1',
        title: `${T3} #1`,
        cwd: '/Users/test/worktrees/k3-a1',
        last_active_at: 3000,
      }),
      sessionShape('s94', {
        status: 'running',
        attempt_id: 'k4-a1',
        title: `${T4} #1`,
        cwd: '/Users/test/worktrees/k4-a1',
        last_active_at: 2000,
      }),
      sessionShape('s95', {
        live: false,
        status: 'saved',
        attempt_id: 'k5-a1',
        title: `${T5} #1`,
        cwd: '/Users/test/worktrees/k5-a1',
        last_active_at: 1000,
      }),
    ],
  });
  // 牆上排四個活的。工作中的排前面：⌘E 的循環從 focusedId 找起，
  // members[0] 是開機的預設落點 —— 讓它落在 s93，第一下 ⌘E 才會
  // 走到「排序最前的等你」（s91），而不是跳過它。
  await seedWall(page, ['s93', 's94', 's91', 's92']);

  await test.step('1. the wall opens — two waiting, two astir, one neutral', async () => {
    await boot(page);

    // (a) 開機落在終端牆，插入點在第一格（s93）的終端裡 —— 牆有活
    // session 時，鍵盤從第一秒就有落點。
    await expectFocusWithin(page, '.pane[data-session-id="s93"] .term-host');

    // (c-1) 側欄「等你」分區恰好列著那兩個，計數也說 2。
    await expect(page.locator('[data-section="waiting"] .session-row')).toHaveCount(2);
    await expect(
      page.locator('[data-section="waiting"] [data-testid="session-s91"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-section="waiting"] [data-testid="session-s92"]'),
    ).toBeVisible();
    await expect(page.locator('[data-section="waiting"] .section-count')).toHaveText('2');
    // (c-2) 琥珀橫幅與分頁徽章同一個數：blocked 壓過一切的那一顆。
    await expect(page.locator('.waiting-banner')).toHaveText('⚠ 2 個等你');
    await expect(page.locator('.tab-badge.waiting')).toHaveText('2');

    // (b) 兩個同時堵著，開機那一刻一次點名（多重朗讀，逐一指名）。
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expectAnnounce(page, `2 個 session 等你：${T1} #1、${T2} #1`);

    // 視圖切換節點：⌘2 上看板。
    await chord(page, '2');
    // (c) 看板站著五張卡，只有兩張在呼吸 —— 不是一板子的條紋。
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.locator('[data-testid="col-running"] .board-card')).toHaveCount(5);
    await expect(page.locator('.board-card.needs-you')).toHaveCount(2);
    await expect(page.getByTestId('task-k1')).toHaveClass(/needs-you/);
    await expect(page.getByTestId('task-k2')).toHaveClass(/needs-you/);
    await expect(page.locator('.board-card.astir')).toHaveCount(2);
    await expect(page.getByTestId('task-k3')).toHaveClass(/astir/);
    await expect(page.getByTestId('task-k4')).toHaveClass(/astir/);
    // 停著的卡不呼吸、不微光：邊緣保持中性 —— 左緣的墨水與呼吸卡
    // 不同色，等的訊號才有辨識度可言。
    await expect(page.getByTestId('task-k5')).not.toHaveClass(/needs-you/);
    await expect(page.getByTestId('task-k5')).not.toHaveClass(/astir/);
    await expect(page.getByTestId('task-k5')).toHaveAttribute('data-live', 'stopped');
    const edges = await page.evaluate(() => {
      const edge = (id: string) =>
        getComputedStyle(document.querySelector(`[data-testid="task-${id}"]`)!)
          .borderLeftColor;
      return { waiting: edge('k1'), idle: edge('k5') };
    });
    expect(edges.idle).not.toBe(edges.waiting);
    // (a) 離開牆，終端把插入點還回來：焦點退到中性起點。
    await expectFocusNeutral(page);
    // (b) 換視圖不是要朗讀的事：通道裡只有（或已清掉）開機那一句。
    await expect(live).toHaveText(/^(2 個 session 等你.*)?$/s);
  });

  await test.step('2. ⌘K with no query — the attention inbox, waiting first', async () => {
    await chord(page, 'k');
    // (c) 面板開著；(a) 焦點在它的輸入框 —— 開門即可打字。
    await expect(page.getByTestId('palette')).toBeVisible();
    await expect(page.getByTestId('palette-input')).toBeFocused();

    // 空查詢是收件匣，不是名錄：第一組是「等你」，站在動作之前；
    // 在做的 session 與卡片一概不列 —— 側欄已經是名錄了。
    const heads = page.locator('.palette-group-head');
    await expect(heads).toHaveCount(2);
    await expect(heads.nth(0)).toHaveText('等你');
    await expect(heads.nth(1)).toHaveText('動作');
    await expect(page.getByTestId('pal-session-s91')).toBeVisible();
    await expect(page.getByTestId('pal-session-s92')).toBeVisible();
    await expect(page.getByTestId('pal-session-s93')).toHaveCount(0);
    await expect(page.getByTestId('pal-task-k5')).toHaveCount(0);
    // 第一列就是排序最前的等你，而且已被選取：⌘K、Enter 是整趟反射。
    await expect(page.locator('.palette-item').first()).toHaveAttribute(
      'data-testid',
      'pal-session-s91',
    );
    await expect(page.getByTestId('pal-session-s91')).toHaveAttribute('aria-selected', 'true');
    // (b) 開面板不是要朗讀的事。
    await expect(live).toHaveText(/^(2 個 session 等你.*)?$/s);

    // 對話框關閉節點：Esc 收面板，焦點回到來處（看板上的中性起點）。
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toHaveCount(0);
    await expectFocusNeutral(page);
  });

  await test.step('3. ⌘E lands in waiting #1; the answer drops the badge to 1', async () => {
    await chord(page, 'e');
    // 視圖切換節點：(c) 牆回來、s91 的格子亮著焦點框。
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane.focused')).toHaveAttribute('data-session-id', 's91');
    // (a) 插入點真的在 s91 的終端裡 —— 答覆只差敲字。
    await expectFocusWithin(page, '.pane[data-session-id="s91"] .term-host');
    // (b) 跳過去不是要朗讀的事；開機那句到時自清 —— 通道保持乾淨。
    await expect(live).toHaveText('');

    // 你在終端裡答了，hook 回報：等你 → 在做。狀態轉變節點。
    await driveStatus(page, 's91', 'running');
    // (c) 橫幅與徽章一起降到 1；看板側的另一張卡還在等。
    await expect(page.locator('.waiting-banner')).toHaveText('⚠ 1 個等你');
    await expect(page.locator('.tab-badge.waiting')).toHaveText('1');
    // (a) 狀態轉變一步都不准偷焦點：插入點原地在 s91 終端。
    await expectFocusWithin(page, '.pane[data-session-id="s91"] .term-host');
    // (b) 「不再等你」不點名 —— 只有進入等待才值得開口。
    await expect(live).toHaveText('');
  });

  await test.step('4. ⌘E again — waiting #2 answered, the badge clears', async () => {
    // 插入點在終端裡：Ctrl+字母屬於 shell，documented 變體加 Shift。
    await chord(page, 'E', { shift: true });
    await expect(page.locator('.pane.focused')).toHaveAttribute('data-session-id', 's92');
    await expectFocusWithin(page, '.pane[data-session-id="s92"] .term-host');

    await driveStatus(page, 's92', 'running');
    // (c) 沒人等你了：橫幅整支退場，等待徽章一顆不剩。
    await expect(page.locator('.waiting-banner')).toHaveCount(0);
    await expect(page.locator('.tab-badge.waiting')).toHaveCount(0);
    // (a)+(b) 同一份紀律。
    await expectFocusWithin(page, '.pane[data-session-id="s92"] .term-host');
    await expect(live).toHaveText('');
  });

  await test.step('5. a turn ends off-screen — the unseen grammar, and its palette group', async () => {
    // 回看板監工 —— 終端從此不在眼前。
    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    await expectFocusNeutral(page);
    // 剛答完的兩張現在也微光：整面牆都在做，沒有一張呼吸。
    await expect(page.locator('.board-card.astir')).toHaveCount(4);
    await expect(page.locator('.board-card.needs-you')).toHaveCount(0);

    // s93 的回合趁你不在時結束。狀態轉變節點。
    await driveStatus(page, 's93', 'idle');
    // (c) 未讀文法三處同亮：側欄小點與加重的列、卡片小點、分頁未讀
    // 膠囊（等待清空後，未讀才輪得到那一格）。
    await expect(page.getByTestId('unseen-s93')).toBeVisible();
    await expect(page.getByTestId('session-s93')).toHaveClass(/unseen/);
    await expect(page.getByTestId('unseen-card-k3')).toBeVisible();
    await expect(page.locator('.tab-badge.unseen')).toHaveText('1');
    // (a) 沒人動你的焦點；(b) 回合結束被聽到 —— 朗讀鏈的那一份。
    await expectFocusNeutral(page);
    await expectAnnounce(page, `「${T3} #1」回合結束`);
    // 安定窗過後，列真的搬進「待命」—— 未選取的 row 不受釘選保護。
    await expect.poll(() => sectionOf(page, 's93')).toBe('idle');

    // 收件匣跟上：⌘K 的第一組換成「完成未看」。
    await chord(page, 'k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await expect(page.getByTestId('palette-input')).toBeFocused();
    const heads = page.locator('.palette-group-head');
    await expect(heads.nth(0)).toHaveText('完成未看');
    await expect(page.getByTestId('pal-session-s93')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('pal-session-s93')).toContainText(`${T3} #1`);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toHaveCount(0);
  });

  await test.step('6. the idle card, merged without a mouse — palette bridge, ⌘I, double-Enter', async () => {
    // 面板領路：打卡片的名字。查詢一到，卡片群組才出場。
    await chord(page, 'k');
    await page.getByTestId('palette-input').fill('整理');
    // Sessions 群組（沒掛終端的 s95 也在名錄裡）站在卡片前；往下一格
    // 選中卡片本人 —— 鍵盤走選取，滑鼠一次都不碰。
    await expect(page.getByTestId('pal-session-s95')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('pal-task-k5')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');

    // 對話框關閉＋視圖切換節點：那座新橋 —— 沒有活終端可落的卡，
    // 面板把人帶上看板、把焦點交到卡片手上，而不是丟在 <body>。
    await expect(page.getByTestId('palette')).toHaveCount(0);
    await expect(page.getByTestId('board')).toBeVisible();
    // (a) 焦點真的在卡片上（停著的卡沒有門，落在卡片本身）。
    await expect(page.getByTestId('task-k5')).toBeFocused();
    // (c) 卡片誠實戴著「未執行」。 (b) 導航不是要朗讀的事。
    await expect(page.getByTestId('state-k5')).toContainText('未執行');
    await expect(live).toHaveText('');

    // 今天的真話（見報告 bug）：停著的卡沒有門，Enter 在卡片上是
    // 死的 —— 什麼都不開。契約先釘在這裡，改了會被看見。
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('task-k5')).toBeFocused();
    await expect(page.locator('.pane[data-session-id="s95"]')).toHaveCount(0);

    // 鍵盤路線由 Tab 接手：第一站就是「繼續」（primary）——
    // Enter 開回終端，這才是停止卡的「Enter opens」。
    await page.keyboard.press('Tab');
    const resume = page.getByTestId('resume-k5');
    await expect(resume).toBeFocused();
    await expect(resume).toHaveText('繼續');
    await page.keyboard.press('Enter');

    // 視圖切換節點：(c) s95 的終端回來了；(a) 插入點在裡面。
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s95"]')).toBeVisible();
    await expectFocusWithin(page, '.pane[data-session-id="s95"] .term-host');
    await expect(live).toHaveText('');

    // CLI 接上後回報安定：回合在你眼前結束 —— 從來不算未讀。
    await driveStatus(page, 's95', 'idle');
    await expect(
      page.locator('[data-testid="session-s95"] .dot.idle'),
    ).toBeVisible();
    await expect(page.getByTestId('unseen-s95')).toHaveCount(0);
    await expect(page.locator('.tab-badge.unseen')).toHaveText('1');

    // worktree 裡有活可看了。
    await page.evaluate(() => {
      window.__mock.diffs.set(
        'k5-a1',
        [
          'diff --git a/README.md b/README.md',
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -1,2 +1,3 @@',
          ' # AgentDesk',
          '+一句話說清楚這是什麼：一張給 agent 的桌子。',
        ].join('\n'),
      );
    });

    // 插入點在終端裡，所以是 Shift 變體。和弦自己走完旅程：
    // (c) 檢視器開著、(a) 焦點落在 diff 本體、(b) 通道沒有為它開口。
    await chord(page, 'I', { shift: true });
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('diff-body')).toBeFocused();
    await expect(live).not.toContainText('檢視');

    // Tab 一下就是 finish footer：diff 的行是 roving focus（tabindex
    // -1），三百行的 diff 不會站在合併鍵前面當三百個 tab stop。
    await page.keyboard.press('Tab');
    const merge = page.getByTestId('merge-attempt');
    await expect(merge).toBeFocused();
    await expect(merge).toHaveText('合併回 main');

    // 合併武裝制：第一下 Enter 只換名字，按鈕指名分支；焦點原地
    // 不動，第二下 Enter 落在同個手感上才開火。
    await page.keyboard.press('Enter');
    const armed = page.getByTestId('confirm-merge');
    await expect(armed).toHaveText('確定合併回 main？');
    await expect(armed).toBeFocused();
    await page.keyboard.press('Enter');

    // (c) toast 確認落地；抽屜收起、worktree 連著 session 一起收回。
    await expect(page.locator('.toast.ok')).toContainText('已合併回 main');
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s95"]')).toHaveCount(0);
    // (b) 合併走 toast，不走朗讀通道。(a) 收走的 pane 把插入點讓給
    // 牆上第一格（s93）—— J1 的桌上沒有別的 pane，焦點才退回 <body>；
    // 平行桌的真話是「換到下一個終端」，兩條 journey 各釘各的。
    await expect(live).not.toContainText('合併');
    await expectFocusWithin(page, '.pane[data-session-id="s93"] .term-host');
    // 被交棒的正是那個「完成未看」的終端：看見即已讀 —— 未讀文法
    // 整組退場，分流在你合併的同一個手勢裡自己走完了一步。
    await expect(page.getByTestId('unseen-s93')).toHaveCount(0);
    await expect(page.getByTestId('unseen-card-k3')).toHaveCount(0);
    await expect(page.locator('.tab-badge.unseen')).toHaveCount(0);

    // 回看板：贏了的卡片戴著紫紅的邊。
    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('task-k5')).toHaveAttribute('data-outcome', 'merged');
    await expect(page.getByTestId('state-k5')).toContainText('已合併');
  });

  await test.step('7. park a settled card — one Enter, no arming, the row leaves the desk', async () => {
    // mock 讓 s94 安定下來（回合在看板前結束 —— 又一筆未讀，這正是
    // 平行桌的日常：訊號疊著來，文法要各自站得住）。狀態轉變節點。
    await driveStatus(page, 's94', 'idle');
    await expectAnnounce(page, `「${T4} #1」回合結束`);
    await expect(page.getByTestId('unseen-card-k4')).toBeVisible();
    await expect(page.locator('.tab-badge.unseen')).toHaveText('1');
    await expectFocusNeutral(page);

    // 鍵盤上卡：門是唯一誠實的 tab stop（程式聚焦不是滑鼠 —— J1 的
    // 同一款起手），Tab 一下就是「暫停」。
    await page.locator('[data-testid="task-k4"] .card-door').focus();
    await page.keyboard.press('Tab');
    const park = page.getByTestId('park-k4');
    await expect(park).toBeFocused();
    await expect(park).toHaveText('暫停');

    // 單擊即停 —— 可逆的動作不武裝，武裝留給不可逆的。一個 Enter，
    // 事情就發生了：這本身就是「沒有武裝」的證明。
    await page.keyboard.press('Enter');
    // 合併的 toast 可能還沒自清（4 秒壽命）—— 指名這一張，別讓兩張
    // ok toast 撞上 strict mode。
    const parkToast = page.locator('.toast.ok').filter({ hasText: '已暫停' });
    await expect(parkToast).toBeVisible();
    await expect(parkToast).toContainText('agentdesk/k4');
    await expect(page.locator('[data-testid^="confirm-"]')).toHaveCount(0);

    // (c) 卡片睡著了：parked 的邊、「已暫停」的狀態行、「繼續」候著；
    // 側欄的活分區失去這一列 —— worktree 連著 session 一起還回去，
    // 未讀也跟著人去樓空（膠囊整顆退場，桌上再無未看的結束）。
    await expect(page.getByTestId('task-k4')).toHaveAttribute('data-live', 'parked');
    await expect(page.getByTestId('state-k4')).toContainText('已暫停');
    await expect(page.getByTestId('resume-k4')).toBeVisible();
    await expect(page.getByTestId('session-s94')).toHaveCount(0);
    await expect(page.locator('.tab-badge.unseen')).toHaveCount(0);
    // (a) 按鈕連著卡腳一起換裝，焦點退回 <body> —— 今天的真話
    // （見報告：park 後沒有安排落點），釘住，改了會被看見。
    await expectFocusNeutral(page);
    // (b) 停放走 toast，不走朗讀通道。
    await expect(live).not.toContainText('已暫停');

    // 桌子的收尾快照：兩張微光（剛答完的 k1/k2）、一張已合併、一張
    // 已暫停、一張待命且已讀 —— 分流做完，桌面說得清楚。
    await expect(page.locator('.board-card.astir')).toHaveCount(2);
    await expect(page.getByTestId('unseen-card-k3')).toHaveCount(0);
    await expect(page.getByTestId('state-k3')).toContainText('待命');
  });
});
