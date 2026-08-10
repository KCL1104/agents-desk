import { test, expect } from '@playwright/test';
import {
  REPO,
  chord,
  coldStart,
  driveStatus,
  expectAnnounce,
  expectFocusWithin,
} from './helpers';

/**
 * J1 —— 第一次用這張桌子，一條不換手的路：
 * 冷啟 → 被招呼 → 開第一張卡 → 開 attempt → 信任門 → 在做 → 等你 →
 * 回合結束（趁你不在）→ 進門看它 → 檢視 diff、留一則意見送回 →
 * 合併 → 卡片收進完成欄 → 重新整理，桌子還記得一切。
 *
 * 與 feature 切片不同的斷言紀律：每個關鍵節點（對話框開合、視圖切換、
 * 狀態轉變）都驗三件事 —— (a) 焦點真正落在哪（document.activeElement），
 * (b) 朗讀通道說了什麼（live-announce），(c) 畫面換上了什麼。節點之間
 * 用普通的可見性斷言接就好。
 */

const FIRST_LINE = '修好登入頁的白畫面';

test('J1 · the first run, end to end', async ({ page }) => {
  // 一條 journey 走完整個桌面生命週期，章節多；90s 是餘裕不是等待 ——
  // 每一步仍然靠 expect 輪詢，絕不 sleep。
  test.setTimeout(90_000);

  const live = page.getByTestId('live-announce');
  const card = page.getByTestId('task-k1');

  await test.step('1. cold start — BootGate resolves into the welcome panel', async () => {
    await coldStart(page);
    // BootGate 放行的證據：app 的骨架（sidebar）站起來了。
    await expect(page.locator('.sidebar')).toBeVisible();

    // 歡迎面板浮著,端出探測的發現 —— 不是問卷,是報告。
    const modal = page.locator('.modal');
    await expect(modal).toContainText('歡迎使用 AgentDesk');
    await expect(page.getByTestId('welcome-claude')).toContainText('✓ 2.1.226');
    await expect(page.getByTestId('welcome-codex')).toContainText('找不到');
    // 心智模型的三點軌:三列、借看板的點語彙。
    const rail = page.locator('.welcome-rail-row');
    await expect(rail).toHaveCount(3);
    await expect(rail.nth(0)).toContainText('一張卡片');

    // (a) 焦點真的在對話框裡 —— modal 的契約,第一個節點就立好。
    await expectFocusWithin(page, '.modal');
    // (b) 朗讀通道存在、polite、而且此刻無話可說。
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('');
  });

  await test.step('2. “Create the first card” lands on the board with the dialog open', async () => {
    await page.getByTestId('welcome-card').click();

    // (c) 腳下已經是看板(第一次的預設落點),新卡對話框開著。
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.locator('.modal h2')).toHaveText('新卡片');
    // (a) 焦點落在標題欄 —— 對話框開門即可打字。
    await expect(page.getByTestId('task-title')).toBeFocused();
    // (b) 開一扇對話框不是要朗讀的事:通道保持安靜。
    await expect(live).toHaveText('');
  });

  await test.step('3. prompt only — the first line becomes the title; ⌘/Ctrl+Enter creates', async () => {
    // 標題留白:第一行就是多數人會打的標題,表單不逼人打兩次。
    await page
      .getByTestId('task-prompt')
      .fill(`${FIRST_LINE}\n\n登入後畫面全白,console 沒有錯誤。先重現再修。`);
    // repo 走「選擇…」—— mock 的 chooser 固定回 picked-repo。
    await page.locator('.modal').getByRole('button', { name: '選擇…' }).click();
    await expect(page.getByTestId('task-repo')).toHaveValue(REPO);
    await expect(page.getByTestId('task-branch')).toHaveValue('main');

    // 多行欄位裡 Enter 是換行;送出走 ⌘/Ctrl+Enter,review 框的同一慣例。
    await page.getByTestId('task-prompt').click();
    await chord(page, 'Enter');

    // (c) 對話框關了,backlog 的卡片戴著 prompt 的第一行。
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('[data-testid="col-backlog"] .board-card')).toHaveCount(1);
    await expect(page.locator('[data-testid="task-k1"] .board-card-title')).toHaveText(
      FIRST_LINE,
    );
    // (a) 焦點落在新卡片上 —— Enter 進門、Tab 就是開始。
    await expect(card).toBeFocused();
    // (b) 建立被說出來:AT 只聽得到落點,原因得靠這一句。
    await expectAnnounce(page, `已建立卡片：「${FIRST_LINE}」`);
  });

  await test.step('4. Start — dialog defaults, prompt preview, then the terminal takes the caret', async () => {
    // 剛聚焦的卡片,Tab 一下就是「開始」—— 鍵盤流不斷手。
    await page.keyboard.press('Tab');
    const start = page.locator('[data-testid="task-k1"] button.primary');
    await expect(start).toBeFocused();
    await expect(start).toHaveText('開始');
    await page.keyboard.press('Enter');

    // (c) 開始對話框:預設 claude、照常詢問,prompt 預覽整段可讀可改。
    await expect(page.locator('.modal h2')).toHaveText(`開始 attempt — ${FIRST_LINE}`);
    await expect(page.getByTestId('attempt-agent')).toHaveValue('claude');
    await expect(page.getByLabel('權限模式')).toHaveValue('normal');
    await expect(
      page.getByTestId('attempt-mode').locator('option:checked'),
    ).toHaveText('照常詢問');
    await expect(page.getByTestId('attempt-prompt')).toHaveValue(
      new RegExp(`AgentDesk 任務.*${FIRST_LINE}`, 's'),
    );
    // (a) 對話框自己拿了鍵盤:第一個控件(agent 選單)持著焦點。
    await expect(page.getByTestId('attempt-agent')).toBeFocused();

    await page.getByTestId('attempt-start').click();

    // (c) 落進終端視圖,pane 上了牆。
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    // (a) 插入點真的在終端裡 —— 信任門的回答只差一個鍵。
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');
    // 第一次開 attempt 的 coach 出現,但不偷焦點 —— 教學不能打斷被教的事。
    await expect(page.getByTestId('coach-attempt')).toBeVisible();
    await expect(page.getByTestId('coach-attempt')).toContainText('worktree');
    expect(
      await page.evaluate(
        () => document.querySelector('.coach')?.contains(document.activeElement) ?? false,
      ),
    ).toBe(false);
    // (b) 出生就停在信任門上:資料夾信任本身就是被等的人。
    await expectAnnounce(page, '等你確認資料夾');
  });

  await test.step('5. trust → working → waiting: the three status surfaces agree', async () => {
    await page.getByTestId('coach-dismiss').click();
    await expect(page.getByTestId('coach-attempt')).toHaveCount(0);

    // 回看板監工。⌘/Ctrl+2 —— 終端裡也通用的視圖和弦。
    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    // 卡片戴著信任門的狀態。
    await expect(page.getByTestId('state-k1')).toContainText('等你確認資料夾');
    await expect(card).toHaveClass(/needs-you/);

    // 把焦點放上卡片的門:接下來的狀態轉變一次都不准偷走它。
    const door = page.locator('[data-testid="task-k1"] .card-door');
    await door.focus();

    // 信任答完,agent 動起來:微光(astir),不呼吸。
    await driveStatus(page, 's1', 'running');
    await expect(card).toHaveClass(/astir/);
    await expect(page.getByTestId('state-k1')).toContainText('執行中');
    await expect(door).toBeFocused();

    // 在做 → 等你:琥珀呼吸的那一刻,三個表面必須同時亮。
    await driveStatus(page, 's1', 'waiting_permission');
    // (c-1) 卡片:呼吸取代微光,狀態行與 aria-label 都說「等你授權」。
    await expect(card).toHaveClass(/needs-you/);
    await expect(card).not.toHaveClass(/astir/);
    await expect(page.getByTestId('state-k1')).toContainText('等你授權');
    await expect(card).toHaveAttribute('aria-label', /等你授權/);
    // (c-2) 側欄:列進了「等你」分區,琥珀橫幅計 1。
    await expect(
      page.locator('[data-section="waiting"] [data-testid="session-s1"]'),
    ).toBeVisible();
    await expect(page.locator('.waiting-banner')).toHaveText('⚠ 1 個等你');
    // (c-3) 分頁徽章:blocked 壓過一切的那一顆。
    await expect(page.locator('.tab-badge.waiting')).toHaveText('1');
    // 第一次「從在做轉進等你」的 coach —— 教琥珀,只教這一次。
    await expect(page.getByTestId('coach-waiting')).toBeVisible();
    await expect(page.getByTestId('coach-waiting')).toContainText('琥珀');
    // (a) 焦點沒被任何一個表面偷走。
    await expect(door).toBeFocused();
    // (b) 朗讀通道說了同一件事。
    await expectAnnounce(page, '等你授權');

    await page.getByTestId('coach-dismiss').click();
    await expect(page.getByTestId('coach-waiting')).toHaveCount(0);
  });

  await test.step('6. answered; the turn ends off-screen — the unseen grammar appears', async () => {
    // 你授權了,agent 繼續做:等待的表面全部退場。
    await driveStatus(page, 's1', 'running');
    await expect(page.locator('.waiting-banner')).toHaveCount(0);
    await expect(page.locator('.tab-badge.waiting')).toHaveCount(0);

    const door = page.locator('[data-testid="task-k1"] .card-door');
    await door.focus();

    // 回合在看板前結束 —— 終端不在眼前,這就是「趁你不在時做完了」。
    await driveStatus(page, 's1', 'idle');
    // (c) 未讀文法三處同亮:側欄小點、卡片小點、分頁未讀膠囊。
    await expect(page.getByTestId('unseen-s1')).toBeVisible();
    await expect(page.getByTestId('unseen-card-k1')).toBeVisible();
    await expect(page.locator('.tab-badge.unseen')).toHaveText('1');
    // (a) 狀態轉變仍不動焦點。
    await expect(door).toBeFocused();
    // (b) 朗讀鏈的那一份:回合結束也要被聽到。
    await expectAnnounce(page, `「${FIRST_LINE} #1」回合結束`);
  });

  await test.step('7. walk in and review: ⌘I lands in the diff, j/k walk, one comment goes back', async () => {
    // 進門看它 —— 看見即已讀,未讀文法整組退場。
    await page.locator('[data-testid="task-k1"] .card-door').click();
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');
    await expect(page.getByTestId('unseen-s1')).toHaveCount(0);
    await expect(page.getByTestId('unseen-card-k1')).toHaveCount(0);
    await expect(page.locator('.tab-badge.unseen')).toHaveCount(0);

    // worktree 裡有活可看了。
    await page.evaluate(() => {
      window.__mock.diffs.set(
        'k1-a1',
        [
          'diff --git a/src/auth.py b/src/auth.py',
          '--- a/src/auth.py',
          '+++ b/src/auth.py',
          '@@ -10,3 +10,4 @@',
          ' def login(request):',
          '+    session = make_session(user)',
          '+    return session',
        ].join('\n'),
      );
    });

    // 插入點在終端裡,所以是 Shift 變體(Ctrl+字母屬於 shell)。
    await chord(page, 'I', { shift: true });
    // (c) 檢視器開在終端旁邊。
    await expect(page.getByTestId('inspector')).toBeVisible();
    // (a) 和弦自己走完旅程:焦點落在 diff 本體,j/k 立刻可用。
    await expect(page.getByTestId('diff-body')).toBeFocused();
    // (b) 開檢視器不是要朗讀的事:通道沒有為它開口。
    await expect(live).not.toContainText('檢視');

    // j/k 走可評論的行 —— roving focus,一行一停。
    await page.keyboard.press('j');
    await expect(page.locator('.diff-line.commentable').first()).toBeFocused();
    await page.keyboard.press('j');
    await expect(page.locator('.diff-line.commentable').nth(1)).toBeFocused();
    await page.keyboard.press('k');
    await expect(page.locator('.diff-line.commentable').first()).toBeFocused();

    // Enter 對準這一行留話,⌘/Ctrl+Enter 收進批次。
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('review-note')).toBeFocused();
    await page.getByTestId('review-note').fill('這裡要先驗證 user 才能開 session');
    await chord(page, 'Enter');
    await expect(page.getByTestId('review-pending')).toContainText(
      '這裡要先驗證 user 才能開 session',
    );
    // 撰寫框借走的插入點還給 diff,下一個 j 接著走。
    await expect(page.getByTestId('diff-body')).toBeFocused();

    // 一批一則,整包送回 session 自己的終端。
    await page.getByTestId('review-send').click();
    await expect(page.getByTestId('review-pending')).toHaveCount(0);
    // Send 之後 caret 回到 diff —— 走查不因送出而斷(丟包已修,
    // 與 ⌘Enter 加註同一條規矩)。
    await expect(page.getByTestId('diff-body')).toBeFocused();
    // 真的送出去了:訊息以 prompt 之姿落在 attempt 的時間線上。
    expect(
      await page.evaluate(() =>
        (window.__mock.events.get('k1-a1') ?? []).some(
          (e) => e.kind === 'prompt' && (e.detail ?? '').includes('這裡要先驗證 user'),
        ),
      ),
    ).toBe(true);
  });

  await test.step('8. merge arms, then lands; the card wears the merged edge in 完成', async () => {
    // 合併武裝制:第一下 Enter 只換名字 —— 按鈕指名分支,第二下才開火。
    const merge = page.getByTestId('merge-attempt');
    await expect(merge).toHaveText('合併回 main');
    await merge.focus();
    await page.keyboard.press('Enter');
    const armed = page.getByTestId('confirm-merge');
    await expect(armed).toHaveText('確定合併回 main？');
    // (a) 同一顆按鈕改名,焦點原地不動 —— 第二下 Enter 落在同個手感上。
    await expect(armed).toBeFocused();
    await page.keyboard.press('Enter');

    // (c) toast 確認落地;抽屜收起,worktree 連著 session 一起收回。
    await expect(page.locator('.toast.ok')).toContainText('已合併回 main');
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await expect(page.locator('.pane')).toHaveCount(0);
    // (a) 終局不丟包:牆空了,app 自己切到看板、把鍵盤放在剛判定的
    // 那張卡上 —— 旅程首跑抓到的丟包(焦點退回 <body>)已修;
    // 判決在哪,焦點就在哪。
    await expect(page.getByTestId('board')).toBeVisible();
    // merged 卡沒有 session 可進、沒有門 —— 落點機制退而聚焦卡片本體,
    // 這正是 ⌘→ 收卡動作要的起點。
    await expect(card).toBeFocused();
    await expect(card).toHaveAttribute('data-outcome', 'merged');
    await expect(page.getByTestId('state-k1')).toContainText('已合併');
    // 「再試一次」不再是 primary —— 勝利的卡片不邀請重做。
    const retry = page.getByTestId('retry-k1');
    await expect(retry).toHaveText('再試一次');
    await expect(retry).toHaveClass(/quiet/);
    await expect(retry).not.toHaveClass(/primary/);
    // 紫紅(--merged)的邊:卡的左緣與狀態行的字共用同一支墨水。
    const edge = await page.evaluate(() => {
      const c = document.querySelector<HTMLElement>('[data-testid="task-k1"]')!;
      const s = document.querySelector<HTMLElement>('[data-testid="state-k1"]')!;
      return { edge: getComputedStyle(c).borderLeftColor, ink: getComputedStyle(s).color };
    });
    expect(edge.edge).toBe(edge.ink);

    // 把卡片收進完成欄 —— 欄位只聽人的手,鍵盤也是一隻手。
    await card.focus();
    await chord(page, 'ArrowRight');
    await expectAnnounce(page, '移到 待驗收');
    await expect(card).toBeFocused();
    await chord(page, 'ArrowRight');
    // (b)+(a)+(c) 搬移的三重奏:說出落點、焦點跟著卡片、完成欄收下它。
    await expectAnnounce(page, '移到 完成');
    await expect(card).toBeFocused();
    await expect(page.locator('[data-testid="col-done"] [data-testid="task-k1"]')).toBeVisible();
    await expect(card).toHaveAttribute('data-outcome', 'merged');
  });

  await test.step('9. epilogue — reload: no re-greeting, the board remembers', async () => {
    await page.reload();
    await expect(page.locator('.sidebar')).toBeVisible();

    // (c) 招呼過就不再招呼:旗標還在,面板不再浮起。
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('agentdesk.welcomed'))).toBe('1');
    // 看板是上次離開的視圖,完成欄裡的卡片還戴著合併的邊。
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.locator('[data-testid="col-done"] [data-testid="task-k1"]')).toBeVisible();
    await expect(card).toHaveAttribute('data-outcome', 'merged');
    await expect(page.getByTestId('state-k1')).toContainText('已合併');
    // 桌子用過了:backlog 的 CTA 縮回短標籤,不再說第一分鐘的長句。
    await expect(page.getByTestId('board-cta')).toHaveText('按 ＋ 新增卡片');
    // (a) 重新整理從中性起點出發,(b) 朗讀通道乾淨。
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await expect(live).toHaveText('');
  });
});
