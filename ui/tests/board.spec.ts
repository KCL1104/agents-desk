import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.getByTestId('view-board').click();
  await expect(page.getByTestId('board')).toBeVisible();
}

async function newCard(page: Page, title: string, repo = REPO, branch = 'main') {
  await page.getByRole('button', { name: '新增卡片' }).click();
  await expect(page.locator('.modal')).toBeVisible();
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(repo);
  await page.getByTestId('task-branch').fill(branch);
  await page.getByTestId('task-create').click();
}

/** Start an attempt on the only card, accepting the prompt as offered. */
async function start(page: Page, taskId: string, agent = 'claude') {
  await page.locator(`[data-testid="task-${taskId}"] button.primary`).click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  if (agent !== 'claude') await page.getByTestId('attempt-agent').selectOption(agent);
  await page.getByTestId('attempt-start').click();
}

/**
 * Drag a card onto a column, or onto another card to insert before it.
 *
 * Synthetic HTML5 drag events, dispatched in one tick. That is stricter than
 * a real drag, where React has many frames to re-render between `dragstart`
 * and `drop` — so a drop that only works because state had settled in between
 * fails here, which is the point.
 */
async function dragCardTo(page: Page, taskId: string, target: string) {
  await page.evaluate(
    ({ taskId, target }) => {
      const card = document.querySelector(`[data-testid="task-${taskId}"]`)!;
      const onto = document.querySelector(`[data-testid="${target}"]`)!;
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      onto.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
      onto.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      card.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    },
    { taskId, target },
  );
}

test.describe('board', () => {
  test('a new card lands in 待辦 and nothing is running behind it', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');

    const card = page.getByTestId('task-k1');
    await expect(page.locator('[data-testid="col-backlog"] .board-card')).toHaveCount(1);
    await expect(card).toContainText('修好登入');
    await expect(page.getByTestId('state-k1')).toHaveText(/尚未開始/);
  });

  /**
   * The acceptance criterion for the whole two-axis idea: a card sitting in a
   * column lights up by itself when its agent is blocked, without anyone
   * opening anything.
   */
  test('a card in 進行中 lights up by itself when its agent needs you', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');

    // Starting an attempt moves the card, and the very first thing a fresh
    // worktree does is ask whether you trust the folder.
    await page.getByTestId('view-board').click();
    await expect(page.locator('[data-testid="col-running"] .board-card')).toHaveCount(1);
    await expect(page.getByTestId('state-k1')).toHaveText(/等你確認資料夾/);
    await expect(page.getByTestId('task-k1')).toHaveClass(/needs-you/);

    // Trust answered: the hook takes over and the card calms down.
    await page.evaluate(() => window.__mock.report('s1', 'running', { tool: 'Bash', detail: 'pytest -v' }));
    await expect(page.getByTestId('state-k1')).toHaveText(/執行中/);
    await expect(page.getByTestId('task-k1')).not.toHaveClass(/needs-you/);
    await expect(page.getByTestId('task-k1')).toContainText('pytest -v');

    // And it lights up again the moment a permission prompt appears — the
    // card is still in 進行中 throughout. Nothing moved it.
    await page.evaluate(() => window.__mock.report('s1', 'waiting_permission'));
    await expect(page.getByTestId('state-k1')).toHaveText(/⚠.*等你授權/);
    await expect(page.getByTestId('task-k1')).toHaveClass(/needs-you/);
    await expect(page.locator('[data-testid="col-running"] .board-card')).toHaveCount(1);
  });

  /**
   * The other half of the same criterion: the card is a way *into* the live
   * terminal, not a summary of it. Clicking has to leave the caret in the
   * TUI, because the next thing you do is answer it.
   */
  test('clicking a waiting card lands in its live TUI with the caret in it', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.getByTestId('view-board').click();
    await page.evaluate(() => window.__mock.report('s1', 'waiting_permission'));

    await page.getByTestId('task-k1').click();

    // We are on the terminal view, showing that session's pane, focused.
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    await expect(page.locator('.pane[data-session-id="s1"]')).toHaveClass(/focused/);

    // And the real caret is inside it, so the answer can just be typed.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const pane = document.querySelector('.pane[data-session-id="s1"]');
          return !!pane && !!document.activeElement && pane.contains(document.activeElement);
        }),
      )
      .toBe(true);
  });

  test('dragging a card to another column moves it, and only a drag does', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');

    await dragCardTo(page, 'k1', 'col-review');
    await expect(page.locator('[data-testid="col-review"] .board-card')).toHaveCount(1);
    await expect(page.locator('[data-testid="col-backlog"] .board-card')).toHaveCount(0);

    // A hook report never moves a card. `Stop` means the turn ended, not that
    // the work is done, and that distance is the reason for two axes.
    await start(page, 'k1');
    await page.getByTestId('view-board').click();
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await expect(page.getByTestId('state-k1')).toHaveText(/待命/);
    await expect(page.locator('[data-testid="col-running"] .board-card')).toHaveCount(1);
    await expect(page.locator('[data-testid="col-done"] .board-card')).toHaveCount(0);
  });

  test('reordering within a column sticks, and survives a reload', async ({ page }) => {
    await boot(page);
    await newCard(page, '第一張');
    await newCard(page, '第二張');
    await newCard(page, '第三張');

    const titles = () =>
      page.locator('[data-testid="col-backlog"] .board-card-title').allTextContents();
    expect(await titles()).toEqual(['第一張', '第二張', '第三張']);

    // Dropped onto the first card, so it goes in front of it.
    await dragCardTo(page, 'k3', 'task-k1');
    expect(await titles()).toEqual(['第三張', '第一張', '第二張']);

    await page.reload();
    await page.getByTestId('view-board').click();
    expect(await titles()).toEqual(['第三張', '第一張', '第二張']);
  });

  /**
   * After every restart this is what the board looks like, so it has to be a
   * first-class state rather than something that reads as broken.
   */
  test('an attempt with no terminal says so and offers to continue', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.getByTestId('view-board').click();

    await page.evaluate(() => void window.__mock);
    await page.locator('.pane[data-session-id="s1"] [data-testid="eject-s1"]').count();
    // The PTY dies, as it would on quit.
    await page.evaluate(() => {
      const s = window.__mock.sessions.find((x) => x.id === 's1')!;
      s.live = false;
      s.status = 'saved';
      window.__mock.pushSessions();
    });

    await expect(page.getByTestId('state-k1')).toHaveText(/未執行/);
    await expect(page.getByTestId('task-k1')).not.toHaveClass(/needs-you/);

    // One click puts a terminal back on it and takes you there.
    await page.getByTestId('resume-k1').click();
    await expect(page.locator('.pane[data-session-id="s1"]')).toHaveClass(/focused/);
    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('state-k1')).toHaveText(/啟動中/);
  });

  test('ad-hoc sessions live outside the board and still get you into their TUI', async ({
    page,
  }) => {
    await boot(page);
    await expect(page.getByTestId('adhoc')).toContainText('沒有臨時 session');

    // Opened from the sidebar, with no card behind it.
    await page.locator('.sidebar-head button.icon').click();
    await page.locator('.modal input.mono').first().fill('/Users/test/scratch');
    await page.locator('.modal button.primary').click();

    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('adhoc-s1')).toBeVisible();
    await expect(page.locator('.board-card')).toHaveCount(0);

    await page.evaluate(() => window.__mock.report('s1', 'waiting_input'));
    await expect(page.getByTestId('adhoc-s1')).toHaveClass(/needs-you/);

    await page.getByTestId('adhoc-s1').click();
    await expect(page.locator('.pane[data-session-id="s1"]')).toHaveClass(/focused/);
  });

  test('the waiting badge counts board attempts and ad-hoc sessions alike', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');

    await page.locator('.sidebar-head button.icon').click();
    await page.locator('.modal input.mono').first().fill('/Users/test/scratch');
    await page.locator('.modal button.primary').click();

    // The attempt is on its trust prompt; put the ad-hoc one on a permission
    // prompt. Both are a person being waited on, and the badge is one number.
    await page.evaluate(() => window.__mock.report('s2', 'waiting_permission'));
    await expect(page.locator('.waiting-banner')).toHaveText(/2 個等你/);
  });

  test('a card whose repository is not one is refused in the dialog', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入', '/Users/test/not-a-repo');

    // A known refusal arrives translated and actionable; the backend's raw
    // words wait one disclosure behind it.
    await expect(page.getByTestId('task-error')).toContainText('不是 git repository');
    await page.getByTestId('task-error').locator('summary').click();
    await expect(page.getByTestId('task-error')).toContainText('not a git repository');
    // The dialog stays open with the typing intact, and no card was made.
    await expect(page.getByTestId('task-title')).toHaveValue('修好登入');
    await expect(page.locator('.board-card')).toHaveCount(0);
  });

  test('a base branch that does not exist is refused in the dialog', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入', REPO, 'no-such-branch');
    await expect(page.getByTestId('task-error')).toContainText('沒有叫「no-such-branch」的分支');
    await expect(page.locator('.board-card')).toHaveCount(0);
  });

  /**
   * Honest degradation. Guessing at another CLI's argument conventions is
   * worse than not trying: the flag that means "here is your prompt" in one
   * means "print this and exit" in another.
   */
  test('an agent we have not measured says it will not send the prompt', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');

    await page.locator('[data-testid="task-k1"] button.primary').click();
    await expect(page.getByTestId('attempt-prompt')).toBeVisible();
    await page.getByTestId('attempt-agent').selectOption('codex');

    await expect(page.getByTestId('attempt-manual')).toBeVisible();
    await expect(page.getByTestId('attempt-start')).toHaveText(/不送 prompt/);
    // The prompt is still built and still there to copy.
    await expect(page.getByTestId('attempt-prompt')).not.toHaveValue('');
    await expect(page.getByTestId('attempt-copy')).toBeVisible();
  });

  test('the prompt is editable, and what you edit is what starts the attempt', async ({
    page,
  }) => {
    await boot(page);
    await newCard(page, '修好登入');

    await page.locator('[data-testid="task-k1"] button.primary').click();
    await expect(page.getByTestId('attempt-prompt')).toContainText('[AgentDesk 任務]');
    await page.getByTestId('attempt-prompt').fill('我自己寫的 prompt');
    await page.getByTestId('attempt-start').click();

    const sent = await page.evaluate(
      () =>
        (
          window.__mock.calls.find((c) => c.cmd === 'open_attempt')?.args as {
            prompt: string;
          }
        ).prompt,
    );
    expect(sent).toBe('我自己寫的 prompt');
  });

  /**
   * Switching agent means another attempt, not a restart of this one. The
   * first is left alone: two agents on one card, each in its own worktree, is
   * a thing worth being able to do, and comparing their diffs is the point.
   */
  test('換 agent opens a second attempt and leaves the first running', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.getByTestId('view-board').click();
    await page.evaluate(() => window.__mock.report('s1', 'running'));

    await page.getByTestId('retry-k1').click();
    await page.getByTestId('attempt-agent').selectOption('codex');
    await page.getByTestId('attempt-start').click();
    await page.getByTestId('view-board').click();

    // Still one card, now with two live sessions behind it.
    await expect(page.locator('.board-card')).toHaveCount(1);
    await expect(page.locator('.session-row')).toHaveCount(2);
    // The card follows the newest attempt.
    await expect(page.getByTestId('task-k1')).toContainText('codex');
    await expect(page.getByTestId('state-k1')).toContainText('#2');

    // And the first attempt is untouched — nothing was superseded behind
    // your back.
    const first = await page.evaluate(
      () => window.__mock.tasks[0].attempts[0].outcome,
    );
    expect(first).toBeNull();
  });

  test('deleting a card takes its attempt session with it', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.getByTestId('view-board').click();
    await expect(page.locator('.session-row')).toHaveCount(1);

    // The first click only arms: a stray click on a 12px ✕ must not be able
    // to take a task's history with it.
    await page.locator('[data-testid="task-k1"] [aria-label="刪除卡片"]').click();
    await expect(page.locator('.board-card')).toHaveCount(1);
    await page.getByTestId('confirm-delete-k1').click();
    await expect(page.locator('.board-card')).toHaveCount(0);
    await expect(page.locator('.session-row')).toHaveCount(0);
  });
});

/**
 * The card's footprint badges: numstat counts and where the branch stands
 * against its base — read from git, never from the terminal.
 */
test.describe('attempt footprint on the card', () => {
  test('a card wears +N −M and ahead/behind', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.evaluate(() => {
      window.__mock.stats.set('k1-a1', { files: 2, adds: 12, dels: 3, ahead: 2, behind: 1 });
    });

    await page.getByTestId('view-board').click();
    const stat = page.getByTestId('stat-k1');
    await expect(stat).toContainText('+12');
    await expect(stat).toContainText('−3');
    await expect(stat).toContainText('↑2');
    // Behind is the merge refusal not yet hit — the one count in warn.
    await expect(stat).toContainText('↓1');
  });

  test('an untouched worktree wears no badge at all', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('state-k1')).toBeVisible();
    await expect(page.getByTestId('stat-k1')).toHaveCount(0);
  });

  test('the drawer meta shows where the branch stands', async ({ page }) => {
    await boot(page);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.evaluate(() => {
      window.__mock.stats.set('k1-a1', { files: 1, adds: 5, dels: 0, ahead: 1, behind: 2 });
    });
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('inspector-behind')).toHaveText('↓2');
  });
});
