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
  sessionShape,
} from './helpers';
import type { MockSession, MockTask } from '../mock-tauri';

/**
 * J3 —— 重啟之後的桌子，一條把它救回來的路：
 * 開機（每個 PTY 都死在上一次退出）→ 看板全是「未執行」的停止卡 →
 * 繼續第一張（--continue：同一個 session、同一個 attempt）→ 喚醒暫停卡
 * （worktree 在原路長回來）→ 打開已合併卡的凍結 diff（唯讀的紀錄）→
 * 中途再冷重載一次 —— 清單活過重啟，是這個產品的核心承諾。
 *
 * 與 J1 同一套斷言紀律：每個關鍵節點（對話框開合、視圖切換、狀態轉變）
 * 驗三件事 —— (a) 焦點真正落在哪（document.activeElement），(b) 朗讀
 * 通道說了什麼（live-announce），(c) 畫面換上了什麼。節點之間用普通的
 * 可見性斷言接就好。
 */

/** k5 的 worktree 原路 —— 喚醒之後 mock 要在同一條路把它長回來。 */
const PARKED_PATH = '/Users/test/worktrees/card-k5';

/** k6 凍結下來的 diff：attempt 結束時的快照，之後只讀不寫。 */
const FROZEN_DIFF = [
  'diff --git a/src/login.ts b/src/login.ts',
  '--- a/src/login.ts',
  '+++ b/src/login.ts',
  '@@ -1,2 +1,3 @@',
  ' export function login() {',
  "+  return redirect('/home');",
  ' }',
].join('\n');

/** 停止卡的種子：attempt 還開著、session 沒有終端機（live:false）——
 *  重啟後每個 attempt 都長這樣，因為 app 退出時殺掉所有 PTY。worktree
 *  一卡一條路（card-k1…），不共用：park 的清場是用路徑前綴掃的。 */
function stoppedCard(n: number): MockTask {
  return cardShape(n, {
    lifecycle: 'running',
    position: n - 1,
    attempts: [
      attemptShape(`k${n}`, 1, {
        worktree_path: `/Users/test/worktrees/card-k${n}`,
        branch: `agentdesk/card-k${n}`,
        session_id: `s9${n}`,
      }),
    ],
  });
}

/** 停止卡的另一半：死掉的 session 本人。saved ＝ 有紀錄、沒終端機。 */
function deadSession(n: number): MockSession {
  return sessionShape(`s9${n}`, {
    live: false,
    status: 'saved',
    attempt_id: `k${n}-a1`,
    title: `卡片 ${n} #1`,
    cwd: `/Users/test/worktrees/card-k${n}`,
  });
}

/**
 * 把重啟後的桌子種進 mock —— 但只種一次。
 *
 * helpers 的 seedDesk 每次載入都重寫種子鍵，而本 journey 的第 5 章正是
 * 「重新整理之後桌子還記得」：mock 的 persist() 寫回同一批鍵，種子若在
 * reload 時再蓋一次，持久化這條契約就永遠測不到。所以在檔案裡自建一個
 * 帶一次性守衛的版本（與 onboarding 的 __rearmedOnce 同一條規矩）。
 */
async function seedRestartDeskOnce(page: Page): Promise<void> {
  const desk: { tasks: MockTask[]; sessions: MockSession[] } = {
    tasks: [
      // 四張停止卡：重啟後的常態。
      stoppedCard(1),
      stoppedCard(2),
      stoppedCard(3),
      stoppedCard(4),
      // 一張暫停卡：worktree 與併發槽在重啟前就還回去了，只剩分支與
      // 對話。parked 蓋過 stopped —— 它是「故意睡著」，不是「被殺掉」。
      cardShape(5, {
        lifecycle: 'running',
        position: 4,
        attempts: [
          attemptShape('k5', 1, {
            worktree_path: PARKED_PATH,
            branch: 'agentdesk/card-k5',
            parked_at: 5000,
            session_id: null,
          }),
        ],
      }),
      // 一張剛合併完的卡：outcome 定了、worktree 收了、diff 凍結了。
      cardShape(6, {
        lifecycle: 'review',
        position: 0,
        attempts: [
          attemptShape('k6', 1, {
            worktree_path: '/Users/test/worktrees/card-k6',
            branch: 'agentdesk/card-k6',
            outcome: 'merged',
            frozen_diff: FROZEN_DIFF,
            session_id: null,
          }),
        ],
      }),
    ],
    sessions: [deadSession(1), deadSession(2), deadSession(3), deadSession(4)],
  };
  await page.addInitScript((d: { tasks: MockTask[]; sessions: MockSession[] }) => {
    if (sessionStorage.getItem('__seededRestartDesk') === null) {
      sessionStorage.setItem('__seededRestartDesk', '1');
      sessionStorage.setItem('__mockTasks', JSON.stringify(d.tasks));
      sessionStorage.setItem('__mockSessions', JSON.stringify(d.sessions));
    }
  }, desk);
}

test('J3 · restart recovery, end to end', async ({ page }) => {
  // 一條 journey 走完重啟復原的整個弧線；90s 是餘裕不是等待 ——
  // 每一步仍然靠 expect 輪詢，絕不 sleep。
  test.setTimeout(90_000);

  const live = page.getByTestId('live-announce');

  await test.step('1. the board after a restart — stopped cards lead with Resume; the quiet rule holds', async () => {
    await seedRestartDeskOnce(page);
    await boot(page);

    // ⌘/Ctrl+2 —— 平常的開機落在終端牆，看板要自己走過去。
    await chord(page, '2');
    // (c) 看板站起來：進行中五張（四停一暫停），待驗收一張（已合併）。
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.locator('[data-testid="col-running"] .board-card')).toHaveCount(5);
    await expect(page.locator('[data-testid="col-review"] .board-card')).toHaveCount(1);
    // (a) 視圖切換不發明焦點：起點是中性的 <body>。
    await expectFocusNeutral(page);
    // (b) 朗讀通道存在、polite、而且此刻無話可說 —— 一桌子停止卡
    // 不是要人動作的訊號。
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveText('');

    // 四張停止卡，每一張都以 primary 的「繼續」領頭 —— 重啟後九成的
    // 答案就是它，不該要人重新發現。
    for (const n of [1, 2, 3, 4]) {
      const card = page.getByTestId(`task-k${n}`);
      await expect(card).toHaveAttribute('data-live', 'stopped');
      await expect(page.getByTestId(`state-k${n}`)).toContainText('未執行');
      const first = card.locator('.board-card-foot button').first();
      await expect(first).toHaveAttribute('data-testid', `resume-k${n}`);
      await expect(first).toHaveClass(/primary/);
      await expect(first).toHaveText('繼續');
      // 靜止態：Park 與換 agent 完全不佔位（display:none），不是變透明。
      // 佔位就等於留著那第二排按鈕，而那正是卡片高度不一致最大的一份。
      await expect(page.getByTestId(`park-k${n}`)).toBeHidden();
      await expect(page.getByTestId(`retry-k${n}`)).toBeHidden();
    }
    // 藏起來的是「暫停」與「換 agent」；「檢視」不藏 —— 看 diff 是
    // 停止卡上第二常見的動作，降噪不降它。
    await expect(page.getByTestId('inspect-k2')).toBeVisible();

    // 瞄準即現身，之一：hover 進卡，兩顆 quiet 全亮；離開就退場。
    await page.getByTestId('task-k2').hover();
    await expect(page.getByTestId('park-k2')).toBeVisible();
    await expect(page.getByTestId('park-k2')).toHaveText('暫停');
    await expect(page.getByTestId('retry-k2')).toBeVisible();
    await expect(page.getByTestId('retry-k2')).toHaveText('換 agent');
    await page.mouse.move(0, 0);
    await expect(page.getByTestId('park-k2')).toBeHidden();
    await expect(page.getByTestId('retry-k2')).toBeHidden();

    // 之二：鍵盤也是一隻手 —— focus 進卡（focus-within）同樣全亮。
    // display:none 的東西進不了 tab 序，所以這一條是它唯一的入口：
    // 焦點先落在卡片自己（或 primary 那顆）上，quiet 才長出來，接著
    // 才輪得到它們。少了這條規則，鍵盤使用者永遠碰不到暫停。
    await page.getByTestId('task-k2').focus();
    await expect(page.getByTestId('park-k2')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('resume-k2')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('park-k2')).toBeFocused();
    // 而且是一卡一亮：焦點搬去 k1，k2 的立刻退回去。
    await page.getByTestId('task-k1').focus();
    await expect(page.getByTestId('park-k1')).toBeVisible();
    await expect(page.getByTestId('park-k2')).toBeHidden();

    // 暫停卡：一樣以 primary 的「繼續」領頭，但沒有 Park —— 已經停著
    // 的東西沒有再停一次的理由。
    const parked = page.getByTestId('task-k5');
    await expect(parked).toHaveAttribute('data-live', 'parked');
    await expect(page.getByTestId('state-k5')).toContainText('已暫停');
    const parkedFirst = parked.locator('.board-card-foot button').first();
    await expect(parkedFirst).toHaveAttribute('data-testid', 'resume-k5');
    await expect(parkedFirst).toHaveClass(/primary/);
    await expect(page.getByTestId('park-k5')).toHaveCount(0);

    // 已合併的卡：勝利不邀請重做 ——「再試一次」是一般按鈕，不是
    // primary。繼續無處可繼續。
    const merged = page.getByTestId('task-k6');
    await expect(merged).toHaveAttribute('data-live', 'finished');
    await expect(merged).toHaveAttribute('data-outcome', 'merged');
    await expect(page.getByTestId('state-k6')).toContainText('已合併');
    await page.getByTestId('task-k6').hover();
    const retry = page.getByTestId('retry-k6');
    await expect(retry).toBeVisible();
    await expect(retry).toHaveText('再試一次');
    await expect(retry).toHaveClass(/quiet/);
    await expect(retry).not.toHaveClass(/primary/);
    await expect(page.getByTestId('resume-k6')).toHaveCount(0);
  });

  await test.step('2. resume the first card — same session, same attempt, straight into the terminal', async () => {
    await page.getByTestId('resume-k1').click();

    // (c) 落進終端視圖，pane 掛的是同一個 session id —— --continue 的
    // 語意：接回 agent 自己的對話史，不是重開一個。
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s91"]')).toBeVisible();
    // (a) 插入點真的在那個終端裡。
    await expectFocusWithin(page, '.pane[data-session-id="s91"] .term-host');
    // (b) 繼續不是要朗讀的事：通道保持安靜。
    await expect(live).toHaveText('');

    // mock 的帳本作證：走的是 reopen_attempt，沒有新 session、沒有新
    // attempt —— 同一列 k1-a1 還掛著 s91，只是活回來了。
    const truth = await page.evaluate(() => ({
      reopens: window.__mock.calls.filter((c) => c.cmd === 'reopen_attempt').length,
      news: window.__mock.calls.filter((c) => c.cmd === 'new_session').length,
      sessionCount: window.__mock.sessions.length,
      attempts: window.__mock.tasks
        .find((t) => t.id === 'k1')!
        .attempts.map((a) => ({ id: a.id, session: a.session_id })),
      liveAgain: window.__mock.sessions.find((s) => s.id === 's91')!.live,
    }));
    expect(truth.reopens).toBe(1);
    expect(truth.news).toBe(0);
    expect(truth.sessionCount).toBe(4);
    expect(truth.attempts).toEqual([{ id: 'k1-a1', session: 's91' }]);
    expect(truth.liveAgain).toBe(true);

    // session 接著活：回到開發中分區，然後轉進等你 —— 狀態轉變的
    // 三重奏必須整組亮起。
    await driveStatus(page, 's91', 'running');
    await expect(
      page.locator('[data-section="working"] [data-testid="session-s91"]'),
    ).toBeVisible();
    await driveStatus(page, 's91', 'waiting_permission');
    // (c) 琥珀橫幅與分頁徽章同時亮。
    await expect(page.locator('.waiting-banner')).toHaveText('⚠ 1 個等你');
    await expect(page.locator('.tab-badge.waiting')).toHaveText('1');
    // (a) 狀態轉變一次都不准偷走插入點。
    await expectFocusWithin(page, '.pane[data-session-id="s91"] .term-host');
    // (b) 朗讀通道說了同一件事，連著 session 的名字。
    await expectAnnounce(page, '卡片 1 #1 等你授權');

    // 你授了權，agent 回去做事：等待的表面整組退場。
    await driveStatus(page, 's91', 'running');
    await expect(page.locator('.waiting-banner')).toHaveCount(0);
    await expect(page.locator('.tab-badge.waiting')).toHaveCount(0);
  });

  await test.step('3. wake the parked card — the worktree regrows at its old path', async () => {
    // 滑鼠先歸零：看板上懸停 session 卡會開 peek，這一章不測它。
    await page.mouse.move(0, 0);
    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    // 剛剛救回來的 k1 現在是活卡：微光（astir），狀態行說執行中。
    await expect(page.getByTestId('task-k1')).toHaveAttribute('data-live', 'session');
    await expect(page.getByTestId('task-k1')).toHaveClass(/astir/);
    await expect(page.getByTestId('state-k1')).toContainText('執行中');
    // (a) 離開終端牆，焦點退回中性起點。
    await expectFocusNeutral(page);
    // (b) 朗讀通道自清的契約：說完 5 秒內清空，舊話不重播。
    await expect(live).toHaveText('', { timeout: 10_000 });

    await page.getByTestId('resume-k5').click();
    // (c) 新終端上牆 —— 新的 session id（s1：暫停時終端已還，喚醒是
    // 重新長一個），但 worktree 在原路長回來。
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    // (a) 插入點跟著落進去。
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');
    // (b) 喚醒本身不朗讀。
    await expect(live).toHaveText('');
    // 貨架下得乾淨：沒有 restore 失敗的 toast。
    await expect(page.locator('.toast.error')).toHaveCount(0);
    const woken = await page.evaluate(() => {
      const attempt = window.__mock.tasks.find((t) => t.id === 'k5')!.attempts[0];
      const session = window.__mock.sessions.find((s) => s.id === 's1')!;
      return { parkedAt: attempt.parked_at, sid: attempt.session_id, cwd: session.cwd };
    });
    expect(woken.parkedAt).toBe(null);
    expect(woken.sid).toBe('s1');
    expect(woken.cwd).toBe(PARKED_PATH);
    // 側欄的列回來了 —— 暫停時它整列消失，喚醒即歸隊。
    await expect(
      page.locator('[data-section="working"] [data-testid="session-s1"]'),
    ).toBeVisible();

    // 卡片回到自己的欄位：還在進行中，只是從「已暫停」變成活的。
    await page.mouse.move(0, 0);
    await chord(page, '2');
    await expect(
      page.locator('[data-testid="col-running"] [data-testid="task-k5"]'),
    ).toBeVisible();
    await expect(page.getByTestId('task-k5')).toHaveAttribute('data-live', 'session');
    await expect(page.getByTestId('state-k5')).toContainText('啟動中');
  });

  await test.step('4. the merged card is a record — frozen diff, no levers', async () => {
    // 今天的真話，先釘住（見報告：這是一個 app 缺陷）：牆上有掛著
    // attempt 的 pane 聚焦時，「檢視」一張已結束的卡會被 drawer-follows-
    // focus 的效果蓋掉 —— 抽屜跳回聚焦 pane 的 attempt（k5-a1，開著的
    // 那個），凍結的紀錄根本開不出來。改了會被這裡看見。
    await page.getByTestId('inspect-k6').click();
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('board')).toHaveCount(0);
    // 抽屜戴的不是「已凍結」的章，而是開著 attempt 的工具列。
    await expect(page.locator('.inspector-frozen')).toHaveCount(0);
    await expect(page.getByTestId('open-shell')).toBeVisible();
    // 回到終端視圖時插入點回到聚焦的 pane —— 也正是它把抽屜拽走的。
    await expectFocusWithin(page, '.pane[data-session-id="s1"] .term-host');

    // 使用者真的能走通的路：開一個空的工作分頁 —— 沒有 pane 聚焦，
    // 抽屜就不再被拽走。
    await page.locator('.tab-add').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.tab.active')).toContainText('工作 2');
    await page.mouse.move(0, 0);
    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    await page.getByTestId('inspect-k6').click();

    // (c) 這回抽屜真的開在紀錄上：戴著「已凍結」的章，凍結的 diff
    // 原樣可讀。
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('board')).toHaveCount(0);
    await expect(page.locator('.inspector-frozen')).toHaveText('已凍結');
    await expect(page.locator('.diff-file')).toContainText('src/login.ts');
    await expect(page.getByTestId('diff-body')).toContainText("return redirect('/home');");
    // (a) 用按鈕開抽屜不搶插入點 —— 只有 ⌘I 的和弦才把焦點送進 diff；
    // 空牆上沒有 pane 接手，焦點退回中性的 <body>。
    await expectFocusNeutral(page);
    // (b) 開一扇唯讀的抽屜沒有要說的話。
    await expect(live).toHaveText('');

    // 唯讀的全部意思：沒有編輯鉛筆、沒有 run/shell/checkpoint/park 的
    // 工具列、沒有 finish footer —— 合併與丟棄都已是過去式。
    await expect(page.locator('[data-testid^="diff-edit-"]')).toHaveCount(0);
    for (const gone of [
      'run-scripts',
      'open-shell',
      'checkpoint-now',
      'park-attempt',
      'ckpt-compare',
      'merge-attempt',
      'discard-attempt',
    ]) {
      await expect(page.getByTestId(gone)).toHaveCount(0);
    }

    // 讀完把紀錄收起來，回到原本的牆 —— 第 5 章要在那裡驗證重載。
    await chord(page, 'i');
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await page.keyboard.press('Control+PageDown');
    await expect(page.locator('.tab.active')).toContainText('工作區');
    // 分頁一換回來，聚焦的 pane（上次親手聚焦的 s1）立刻拿回插入點。
    await expect(page.locator('.pane.focused')).toHaveAttribute('data-session-id', 's1');
    await expectFocusWithin(page, '.pane.focused .term-host');
  });

  await test.step('5. cold reload mid-journey — the list survives, the product keeps its promise', async () => {
    // UI 之後要重讀的那份事實，先驗明正身：mock 的 persist() 把整張桌
    // 子寫回種子鍵 —— 活過來的兩個 session、醒了的 k5、合併定案的 k6。
    const persisted = await page.evaluate(() => {
      const sessions = JSON.parse(sessionStorage.getItem('__mockSessions') ?? '[]') as Array<{
        id: string;
        live: boolean;
      }>;
      const tasks = JSON.parse(sessionStorage.getItem('__mockTasks') ?? '[]') as Array<{
        id: string;
        attempts: Array<{ parked_at: number | null; outcome: string | null }>;
      }>;
      return {
        liveIds: sessions.filter((s) => s.live).map((s) => s.id).sort(),
        k5parked: tasks.find((t) => t.id === 'k5')!.attempts[0].parked_at,
        k6outcome: tasks.find((t) => t.id === 'k6')!.attempts[0].outcome,
      };
    });
    expect(persisted.liveIds).toEqual(['s1', 's91']);
    expect(persisted.k5parked).toBe(null);
    expect(persisted.k6outcome).toBe('merged');

    await page.reload();
    await expect(page.locator('.sidebar')).toBeVisible();
    // 用過的桌子不再被招呼。
    await expect(page.locator('.modal')).toHaveCount(0);

    // (c) 核心承諾：救回來的 session 還在 —— 側欄有列、牆上有 pane。
    await expect(page.locator('[data-testid="session-s91"]')).toBeVisible();
    await expect(page.locator('[data-testid="session-s1"]')).toBeVisible();
    await expect(page.locator('.pane[data-session-id="s91"]')).toBeVisible();
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    // (a) 重載後第一個 pane 拿回插入點 —— 佈局記得誰在第一格。
    await expect(page.locator('.pane.focused')).toHaveAttribute('data-session-id', 's91');
    await expectFocusWithin(page, '.pane.focused .term-host');
    // (b) 沒有人在等你，通道就沒有話。
    await expect(live).toHaveText('');

    // 看板把每一個結局都記得。
    await page.mouse.move(0, 0);
    await chord(page, '2');
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('task-k1')).toHaveAttribute('data-live', 'session');
    await expect(page.getByTestId('task-k5')).toHaveAttribute('data-live', 'session');
    for (const n of [2, 3, 4]) {
      await expect(page.getByTestId(`task-k${n}`)).toHaveAttribute('data-live', 'stopped');
      await expect(page.getByTestId(`resume-k${n}`)).toHaveClass(/primary/);
    }
    await expect(page.getByTestId('task-k6')).toHaveAttribute('data-outcome', 'merged');
    await expect(page.getByTestId('state-k6')).toContainText('已合併');
  });
});
