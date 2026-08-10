import { test, expect, type Page } from '@playwright/test';
import { installMock } from '../mock-tauri';
import { format, zhTW } from '../../src/i18n/messages';
import { REPO, chord, driveStatus, expectAnnounce, expectFocusWithin } from './helpers';

/**
 * J5 —— 中文系統上的第一次，走 J1 的骨架，說 zh-TW 型錄裡真正的句子：
 * 冷啟（navigator 是 zh、沒有任何儲存選擇）→ 被中文招呼 → 長 CTA 開卡 →
 * IME 守門 → CJK 排版契約 → 信任門 → 等你 → coach 教本平台的跳鍵 →
 * 回合結束 → 合併，卡片戴上中文的判決 → reload，桌子還是中文。
 *
 * 與 J1 相同的斷言紀律（關鍵節點驗焦點/朗讀/畫面三件事），再加上
 * 中文獨有的五條契約：
 *   (1) IME 組字中的 Enter 不得送出表單 —— zh-TW 打字每個詞組都以
 *       Enter 收尾，守門失效等於沒辦法打中文；
 *   (2) 長 CJK 標題在卡片上剪成兩行，不外溢；
 *   (3) 卡片 footer 的按鈕永不在詞中折行（繼/續 疊起來是另一個詞）；
 *   (4) aria-label 用型錄的「，」（common.sep）連接，不是英文的 ', '；
 *   (5) <html lang> 跟著語言走 —— app 寫的是 locale 標籤本身
 *       （zh-TW，BCP 47 的正體中文標籤），照它的真話斷言。
 */

/** 型錄的短寫：J5 斷言的每一句中文都出自 zh-TW 型錄本人，不手抄。 */
const zh = (key: keyof typeof zhTW, vars?: Record<string, string | number>) =>
  format(zhTW[key], vars);

/** 「，」—— aria-label 的連接詞，契約 (4) 的主角。 */
const SEP = zhTW['common.sep'];

/** 一個真的會被打出來的長標題：55 個上下的 CJK 字元，窄欄裡遠超過
 *  兩行 —— 契約 (2) 的剪裁得有東西可剪才算數。 */
const TITLE =
  '把行動版登入頁在弱網路下偶發的白畫面問題查清楚並徹底修好，補上端對端測試，讓之後的重構不會再讓同一個畫面白掉';

/**
 * 中文系統的冷啟。
 *
 * helpers 的 coldStart 只重新武裝一次性表面；這裡多做一件事：把 mock
 * 預釘的 agentdesk.locale 也撤掉，讓語言走真正的偵測路徑（儲存選擇
 * 優先，否則 navigator 是 zh* 就中文）—— i18n.spec 的 boot 同一份寫法。
 * 撤除只做一次（sentinel 守著）：reload 時 mock 會重釘 zh-TW，那正是
 * 「儲存選擇獲勝」的持久化語意，尾聲靠它證明中文活過重新整理。
 * navigator 的覆寫則每次載入都要重講 —— init script 在全新的 JS
 * context 執行，第一次講的話 reload 後就不在了。
 */
async function coldStartZhSystem(page: Page): Promise<void> {
  await page.addInitScript(installMock);
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__j5FreshOnce') === null) {
      sessionStorage.setItem('__j5FreshOnce', '1');
      localStorage.removeItem('agentdesk.welcomed');
      localStorage.removeItem('agentdesk.coach');
      localStorage.removeItem('agentdesk.locale');
    }
    const opts = { configurable: true };
    Object.defineProperty(navigator, 'languages', { ...opts, get: () => ['zh-TW'] });
    Object.defineProperty(navigator, 'language', { ...opts, get: () => 'zh-TW' });
  });
  await page.goto('/');
}

/**
 * 對一個欄位派發一顆 Enter，可指定它是否在 IME 組字之中。
 *
 * Playwright 的 keyboard 撥不出組字中的鍵（真 IME 不在 DevTools 協定的
 * 掌握裡），所以走 dispatchEvent：KeyboardEventInit 的 isComposing 正是
 * app 守門讀的那一格（e.nativeEvent.isComposing），React 的 root 監聽
 * 對手派事件照樣起反應。同一條派發路徑、唯一的變因是 isComposing ——
 * 之後用 isComposing:false 的同款事件證明路徑通到守門本人，被擋下的
 * 就只能是那面旗。
 */
async function dispatchEnter(
  page: Page,
  testid: string,
  opts: { composing: boolean; ctrl?: boolean },
): Promise<void> {
  await page.evaluate(
    ({ testid, composing, ctrl }) => {
      const el = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
      if (!el) throw new Error(`no such field: ${testid}`);
      el.focus();
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          composed: true,
          isComposing: composing,
          ctrlKey: Boolean(ctrl),
        }),
      );
    },
    { testid, composing: opts.composing, ctrl: opts.ctrl ?? false },
  );
}

/** 到目前為止真的送進核心幾次 create_task —— IME 守門的鐵證：
 *  「畫面還開著」可能只是動畫慢，「命令一次都沒出門」不會。 */
async function createTaskCalls(page: Page): Promise<number> {
  return page.evaluate(
    () => window.__mock.calls.filter((c) => c.cmd === 'create_task').length,
  );
}

test('J5 · the zh-TW journey, end to end', async ({ page }) => {
  // 章節多的一條線；90s 是餘裕不是等待 —— 每一步靠 expect 輪詢，不 sleep。
  test.setTimeout(90_000);

  const live = page.getByTestId('live-announce');
  const card = page.getByTestId('task-k1');

  await test.step('1. 中文系統冷啟 — 沒有儲存選擇，navigator 的 zh 就夠', async () => {
    await coldStartZhSystem(page);
    await expect(page.locator('.sidebar')).toBeVisible();

    // (c) 歡迎面板說中文：標題、主要出口、探測報告的「找不到」。
    const modal = page.locator('.modal');
    await expect(modal).toContainText(zh('welcome.title'));
    await expect(page.getByTestId('welcome-card')).toHaveText(zh('welcome.newCard'));
    await expect(page.getByTestId('welcome-codex')).toContainText(zh('env.claudeMissing'));
    // 契約 (5)：<html lang> 跟著語言走。app 寫的是 locale 標籤本身 ——
    // zh-TW（BCP 47 的正體中文），不是 script 子標籤 zh-Hant；照真話釘。
    await expect
      .poll(() => page.evaluate(() => document.documentElement.lang))
      .toBe('zh-TW');
    // 開場語言也推給了後端 —— 系統本來就是中文的人從不碰選單，
    // 原生通知照樣得是中文（i18n.spec 立的同一條約）。
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__mock.calls.some(
            (c) => c.cmd === 'set_locale' && (c.args as { locale?: string }).locale === 'zh-TW',
          ),
        ),
      )
      .toBe(true);

    // (a) 焦點真的在對話框裡；(b) 朗讀通道 polite、此刻無話可說。
    await expectFocusWithin(page, '.modal');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('');
  });

  await test.step('2. 關閉歡迎 — 空桌的看板說完整的第一句', async () => {
    await page.locator('.modal button', { hasText: zh('common.close') }).click();

    // (c) 腳下是看板，欄頭是中文，CTA 是那句完整的長邀請。
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByRole('tab', { name: zh('view.board') })).toBeVisible();
    await expect(page.locator('[data-testid="col-backlog"] .board-col-head')).toContainText(
      zh('lifecycle.backlog'),
    );
    await expect(page.getByTestId('board-cta')).toHaveText(zh('board.emptyBacklogFirst'));
    // (a) Modal 收起時把焦點還回它借走的地方 —— 開場那裡是 <body>。
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    // (b) 關一扇門不是要朗讀的事。
    await expect(live).toHaveText('');
  });

  await test.step('3. 新卡片 — IME 組字中的 Enter 不許送出', async () => {
    // 空 backlog 的字就是按鈕：長 CTA 本人開對話框。
    await page.getByTestId('board-cta').click();
    await expect(page.locator('.modal h2')).toHaveText(zh('newTask.title'));
    // (a) 開門即可打字；(b) 開對話框保持安靜。
    await expect(page.getByTestId('task-title')).toBeFocused();
    await expect(live).toHaveText('');

    // 把表單填到「一顆 Enter 就會送出」的狀態 —— 守門測試的前提：
    // 若不是 ready，submit 本來就不會走，擋不擋都看不出來。
    await page.getByTestId('task-title').fill(TITLE);
    await page
      .getByTestId('task-prompt')
      .fill('登入後畫面全白，console 沒有錯誤。先重現再修，修完把測試補齊。');
    await page.locator('.modal').getByRole('button', { name: zh('common.choose') }).click();
    await expect(page.getByTestId('task-repo')).toHaveValue(REPO);
    await expect(page.getByTestId('task-branch')).toHaveValue('main');
    await expect(page.getByTestId('task-create')).toBeEnabled();

    // 契約 (1a)：標題欄裡，組字確認的那顆 Enter 不是送出。
    await dispatchEnter(page, 'task-title', { composing: true });
    await expect(page.locator('.modal')).toBeVisible();
    expect(await createTaskCalls(page)).toBe(0);

    // 契約 (1b)：prompt 欄的送出和弦（Ctrl+Enter）在組字中同樣不開火。
    await dispatchEnter(page, 'task-prompt', { composing: true, ctrl: true });
    await expect(page.locator('.modal')).toBeVisible();
    expect(await createTaskCalls(page)).toBe(0);

    // 對照組：同一條派發路徑、isComposing:false —— 立刻送出。
    // 前兩顆被擋下的因此只能是 isComposing 這面旗，不是路徑斷了。
    await dispatchEnter(page, 'task-title', { composing: false });
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(await createTaskCalls(page)).toBe(1);

    // (c) 卡片戴著整句長標題；(a) 焦點落在新卡片上；(b) 建立被中文說出。
    await expect(page.locator('[data-testid="col-backlog"] .board-card')).toHaveCount(1);
    await expect(page.locator('[data-testid="task-k1"] .board-card-title')).toHaveText(TITLE);
    await expect(card).toBeFocused();
    await expectAnnounce(page, zh('newTask.created', { title: TITLE }));
  });

  await test.step('4. CJK 排版契約 — 標題剪兩行、footer 不在詞中折行', async () => {
    // 契約 (2)：長 CJK 標題以 -webkit-line-clamp 剪成兩行。三個事實一起
    // 驗：規則本人（clamp/display/overflow）、真的有東西被剪（scroll >
    // client）、剪的位置是兩行（client ≤ 2×行高）。
    const title = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>(
        '[data-testid="task-k1"] .board-card-title',
      )!;
      const cs = getComputedStyle(el);
      return {
        clamp: cs.getPropertyValue('-webkit-line-clamp').trim(),
        display: cs.display,
        overflow: cs.overflow,
        client: el.clientHeight,
        scroll: el.scrollHeight,
        lineHeight: parseFloat(cs.lineHeight),
      };
    });
    expect(title.clamp).toBe('2');
    // 新版 Chromium 把 line-clamp 標準化了：老寫法 display:-webkit-box
    // 的計算值映成 flow-root，剪裁行為不變 —— 兩種拼法都是同一條規則。
    expect(['-webkit-box', 'flow-root']).toContain(title.display);
    expect(title.overflow).toBe('hidden');
    expect(Number.isFinite(title.lineHeight)).toBe(true);
    // 這個標題真的太長 —— 有剪裁發生，而且停在第二行的下緣。
    expect(title.scroll).toBeGreaterThan(title.client);
    expect(title.client).toBeLessThanOrEqual(title.lineHeight * 2 + 2);

    // 契約 (3)：footer 的每一顆按鈕 white-space:nowrap —— 「繼續」被折成
    // 直排的「繼/續」讀起來是另一個詞；擠不下就整顆換行，不拆字。
    const feet = page.locator('[data-testid="task-k1"] .board-card-foot button');
    const n = await feet.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await expect(feet.nth(i)).toHaveCSS('white-space', 'nowrap');
    }
    // 其中一顆就是中文的「開始」。
    await expect(page.locator('[data-testid="task-k1"] button.primary')).toHaveText(
      zh('board.start'),
    );
  });

  await test.step('5. 開 attempt — 中文的對話框預設，終端接走插入點', async () => {
    // 剛聚焦的卡片，Tab 一下就是「開始」—— 鍵盤流不斷手。
    await page.keyboard.press('Tab');
    const start = page.locator('[data-testid="task-k1"] button.primary');
    await expect(start).toBeFocused();
    await page.keyboard.press('Enter');

    // (c) 對話框整身中文：標題、權限模式的可見標籤、預設「照常詢問」。
    await expect(page.locator('.modal h2')).toHaveText(zh('attempt.startTitle', { title: TITLE }));
    await expect(page.getByTestId('attempt-agent')).toHaveValue('claude');
    await expect(page.getByLabel(zh('attempt.modeLabel'))).toHaveValue('normal');
    await expect(page.getByTestId('attempt-mode').locator('option:checked')).toHaveText(
      zh('mode.normal'),
    );
    await expect(page.getByTestId('attempt-prompt')).toHaveValue(
      new RegExp(`AgentDesk 任務.*${TITLE}`, 's'),
    );
    // (a) 對話框自己拿了鍵盤：第一個控件持著焦點。
    await expect(page.getByTestId('attempt-agent')).toBeFocused();

    await page.getByTestId('attempt-start').click();

    // (c) 落進終端視圖；(a) 插入點真的在終端裡。
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');
    // 第一次的 coach 用中文教 worktree，而且不偷焦點。
    await expect(page.getByTestId('coach-attempt').locator('.coach-title')).toHaveText(
      zh('coach.attempt.title'),
    );
    await expect(page.getByTestId('coach-dismiss')).toHaveText(zh('coach.gotIt'));
    expect(
      await page.evaluate(
        () => document.querySelector('.coach')?.contains(document.activeElement) ?? false,
      ),
    ).toBe(false);
    // (b) 出生就停在信任門上：中文的狀態詞第一次被朗讀。
    await expectAnnounce(page, zh('status.awaiting_trust'));
  });

  await test.step('6. 信任門的看板真相 — aria-label 用「，」連接', async () => {
    await page.getByTestId('coach-dismiss').click();
    await expect(page.getByTestId('coach-attempt')).toHaveCount(0);

    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    // (c) 卡片戴著中文的信任門狀態。
    await expect(card).toHaveClass(/needs-you/);
    await expect(page.getByTestId('state-k1')).toContainText(zh('status.awaiting_trust'));

    // 契約 (4)：AT 聽到的整句 —— 標題，需要你，等你確認資料夾 ——
    // 連接詞是型錄的「，」，一個英文的 ', ' 都不許混進中文句子。
    const label = await card.getAttribute('aria-label');
    expect(label).toBe(`${TITLE}${SEP}${zh('board.needsYou')}${SEP}${zh('status.awaiting_trust')}`);
    expect(label).not.toContain(', ');
  });

  await test.step('7. 在做 → 等你 — coach 教「有 agent 在等你」和本平台的跳鍵', async () => {
    // 把焦點放上卡片的門：狀態轉變一次都不准偷走它。
    const door = page.locator('[data-testid="task-k1"] .card-door');
    await door.focus();

    // 信任答完，agent 動起來：微光與中文的「執行中」。
    await driveStatus(page, 's1', 'running');
    await expect(card).toHaveClass(/astir/);
    await expect(page.getByTestId('state-k1')).toContainText(zh('status.running'));
    await expect(door).toBeFocused();

    // 在做 → 等你：中文的三個表面同時亮。
    await driveStatus(page, 's1', 'waiting_permission');
    // (c-1) 卡片：狀態行與 aria-label 都說「等你授權」，連接詞照舊是「，」。
    await expect(card).toHaveClass(/needs-you/);
    await expect(page.getByTestId('state-k1')).toContainText(zh('status.waiting_permission'));
    expect(await card.getAttribute('aria-label')).toBe(
      `${TITLE}${SEP}${zh('board.needsYou')}${SEP}${zh('status.waiting_permission')}`,
    );
    // (c-2) 側欄：琥珀橫幅的中文計數；等你分區收下這一列。
    await expect(page.locator('.waiting-banner')).toHaveText(
      zh('sidebar.waitingCount', { count: 1 }),
    );
    await expect(
      page.locator('[data-section="waiting"] [data-testid="session-s1"]'),
    ).toBeVisible();
    // (c-3) 分頁徽章：blocked 壓過一切的那一顆。
    await expect(page.locator('.tab-badge.waiting')).toHaveText('1');

    // coach 的中文課：標題是型錄那句「有 agent 在等你」，內文的 {jump}
    // 代入的是「這台機器」的和弦 —— 判準與 app 的 platform.ts 同一份
    // 事實（mac 家族 ⌘E，其餘 Ctrl+E）：教一顆鍵盤上不存在的鍵，教的
    // 就是錯的。
    const jump = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')
        ? '⌘E'
        : 'Ctrl+E',
    );
    const coach = page.getByTestId('coach-waiting');
    await expect(coach.locator('.coach-title')).toHaveText(zh('coach.waiting.title'));
    await expect(coach.locator('.coach-body')).toHaveText(
      zhTW['coach.waiting.body'].replace('{jump}', jump),
    );
    // 佔位符本人絕不許漏到畫面上。
    await expect(coach.locator('.coach-body')).not.toContainText('{jump}');

    // (a) 焦點沒被任何表面偷走；(b) 朗讀通道說了同一個中文狀態詞。
    await expect(door).toBeFocused();
    await expectAnnounce(page, zh('status.waiting_permission'));

    await page.getByTestId('coach-dismiss').click();
    await expect(coach).toHaveCount(0);
  });

  await test.step('8. 授權後回合在看板前結束 — 中文的未讀朗讀', async () => {
    await driveStatus(page, 's1', 'running');
    await expect(page.locator('.waiting-banner')).toHaveCount(0);
    await expect(page.locator('.tab-badge.waiting')).toHaveCount(0);

    const door = page.locator('[data-testid="task-k1"] .card-door');
    await door.focus();

    await driveStatus(page, 's1', 'idle');
    // (c) 未讀文法三處同亮。
    await expect(page.getByTestId('unseen-s1')).toBeVisible();
    await expect(page.getByTestId('unseen-card-k1')).toBeVisible();
    await expect(page.locator('.tab-badge.unseen')).toHaveText('1');
    // (a) 狀態轉變仍不動焦點；(b) 回合結束以中文的句式被聽到 ——
    // session 的名字是「標題 #1」，整句出自 announce.finished。
    await expect(door).toBeFocused();
    await expectAnnounce(page, zh('announce.finished', { title: `${TITLE} #1` }));
  });

  await test.step('9. 合併 — 按鈕指名分支，卡片戴上中文的判決', async () => {
    // 進門看它，未讀退場。
    await page.locator('[data-testid="task-k1"] .card-door').click();
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');
    await expect(page.getByTestId('unseen-s1')).toHaveCount(0);

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

    // 插入點在終端裡，所以是 Shift 變體。和弦自己走完旅程：diff 持焦。
    await chord(page, 'I', { shift: true });
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('diff-body')).toBeFocused();

    // 合併武裝制，兩下都說中文：先「合併回 main」，再「確定合併回 main？」。
    const merge = page.getByTestId('merge-attempt');
    await expect(merge).toHaveText(zh('inspector.mergeInto', { branch: 'main' }));
    await merge.focus();
    await page.keyboard.press('Enter');
    const armed = page.getByTestId('confirm-merge');
    await expect(armed).toHaveText(zh('inspector.confirmMerge', { branch: 'main' }));
    // (a) 同一顆按鈕改名，焦點原地不動。
    await expect(armed).toBeFocused();
    await page.keyboard.press('Enter');

    // (c) 中文的確認 toast；抽屜與 pane 一起收回。
    await expect(page.locator('.toast.ok')).toContainText(zh('inspector.merged', { branch: 'main' }));
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await expect(page.locator('.pane')).toHaveCount(0);

    // 回看板：贏了的卡片，判決是中文的「已合併」。
    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(card).toHaveAttribute('data-outcome', 'merged');
    await expect(page.getByTestId('state-k1')).toContainText(zh('outcome.merged'));
    await expect(page.getByTestId('retry-k1')).toHaveText(zh('board.retry'));
    // 契約 (4) 的收尾：判決句同樣以「，」連接 —— 標題，已合併。
    const label = await card.getAttribute('aria-label');
    expect(label).toBe(`${TITLE}${SEP}${zh('outcome.merged')}`);
    expect(label).not.toContain(', ');
  });

  await test.step('10. 尾聲 — reload：不再被招呼，桌子還是中文', async () => {
    await page.reload();
    await expect(page.locator('.sidebar')).toBeVisible();

    // (c) 招呼過就不再招呼；語言活過重新整理 —— 分頁、CTA、判決全是中文。
    await expect(page.locator('.modal')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('agentdesk.welcomed'))).toBe('1');
    await expect(page.getByRole('tab', { name: zh('view.board') })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.lang))
      .toBe('zh-TW');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(card).toHaveAttribute('data-outcome', 'merged');
    await expect(page.getByTestId('state-k1')).toContainText(zh('outcome.merged'));
    // 桌子用過了：backlog 的 CTA 縮回中文的短標籤。
    await expect(page.getByTestId('board-cta')).toHaveText(zh('board.emptyBacklog'));
    // (a) 重新整理從中性起點出發；(b) 朗讀通道乾淨。
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
    await expect(live).toHaveText('');
  });
});
