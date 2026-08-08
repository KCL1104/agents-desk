import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boot(page: Page, maxConcurrent = 1) {
  await page.addInitScript(installMock);
  await page.addInitScript((max) => {
    // Set before any app code runs, so the board's first read agrees with it.
    const apply = () => {
      if (window.__mock) window.__mock.maxConcurrent = max;
      else queueMicrotask(apply);
    };
    apply();
  }, maxConcurrent);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.getByTestId('view-board').click();
}

async function newCard(page: Page, title: string) {
  await page.getByRole('button', { name: '新增卡片' }).click();
  await page.getByTestId('task-title').fill(title);
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
}

async function start(page: Page, taskId: string) {
  await page.locator(`[data-testid="task-${taskId}"] button.primary`).click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();
}

test.describe('concurrency queue', () => {
  /**
   * The acceptance for M4's second half: over the limit a card waits, and when
   * a slot frees it goes by itself. The answer to "too many at once" is
   * "later", not "no".
   */
  test('a card over the limit waits, then starts on its own', async ({ page }) => {
    await boot(page, 1);
    await newCard(page, '第一張');
    await newCard(page, '第二張');

    await start(page, 'k1');
    await expect(page.getByTestId('state-k1')).toHaveText(/等你確認資料夾/);

    await start(page, 'k2');
    // Waiting, and saying where — not "not started", which is the one reading
    // that would make someone press 開始 again.
    await expect(page.getByTestId('state-k2')).toHaveText(/排隊中 · 第 1 個/);
    await expect(page.getByTestId('queue-count')).toHaveText(/1 個排隊中/);
    // No worktree was made for it yet.
    await expect(page.locator('.session-row')).toHaveCount(1);

    // A slot frees.
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await page.locator('.pane[data-session-id="s1"]').count();
    await page.evaluate(async () => {
      await (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke('close_session', { id: 's1' });
    });

    // And the queue moves without anybody pressing anything. The closed s1
    // files itself under 已完成 — which starts collapsed — so the visible
    // rows are s2's, and s1 shows up in the section's count.
    await expect(page.getByTestId('state-k2')).toHaveText(/等你確認資料夾/);
    await expect(page.getByTestId('queue-count')).toHaveCount(0);
    await expect(page.locator('.session-row')).toHaveCount(1);
    await expect(page.locator('[data-section="done"] .section-count')).toHaveText('1');
  });

  test('the running count and the limit are both on screen', async ({ page }) => {
    await boot(page, 2);
    await newCard(page, '第一張');
    await expect(page.getByTestId('concurrency-max')).toHaveText('0 / 2');

    await start(page, 'k1');
    await expect(page.getByTestId('concurrency-max')).toHaveText('1 / 2');
  });

  /** Raising the limit is a way of saying "go now", so it has to be one. */
  test('raising the limit releases what was waiting', async ({ page }) => {
    await boot(page, 1);
    await newCard(page, '第一張');
    await newCard(page, '第二張');
    await start(page, 'k1');
    await start(page, 'k2');
    await expect(page.getByTestId('state-k2')).toHaveText(/排隊中/);

    await page.getByRole('button', { name: '增加同時執行數' }).click();

    await expect(page.getByTestId('state-k2')).toHaveText(/等你確認資料夾/);
    await expect(page.getByTestId('concurrency-max')).toHaveText('2 / 2');
  });

  test('a queued card can be taken back out of the queue', async ({ page }) => {
    await boot(page, 1);
    await newCard(page, '第一張');
    await newCard(page, '第二張');
    await start(page, 'k1');
    await start(page, 'k2');

    await page.getByTestId('unqueue-k2').click();
    await expect(page.getByTestId('state-k2')).toHaveText(/尚未開始/);
    await expect(page.getByTestId('queue-count')).toHaveCount(0);
  });

  /** An ad-hoc session is something a person opened and is already looking at. */
  test('ad-hoc sessions do not use up the limit', async ({ page }) => {
    await boot(page, 1);
    await page.locator('.sidebar-head button.icon').click();
    await page.locator('.modal input.mono').first().fill('/Users/test/scratch');
    await page.locator('.modal button.primary').click();

    await page.getByTestId('view-board').click();
    await newCard(page, '第一張');
    await start(page, 'k1');

    await expect(page.getByTestId('state-k1')).toHaveText(/等你確認資料夾/);
    await expect(page.getByTestId('queue-count')).toHaveCount(0);
  });
});

test.describe('finishing an attempt', () => {
  async function withAttempt(page: Page) {
    await boot(page, 3);
    await newCard(page, '修好登入');
    await start(page, 'k1');
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('inspector')).toBeVisible();
  }

  test('merging folds the branch back and closes the attempt out', async ({ page }) => {
    await withAttempt(page);
    await expect(page.getByTestId('merge-attempt')).toHaveText(/合併回 main/);

    await page.getByTestId('merge-attempt').click();

    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('state-k1')).toHaveText(/已合併/);
    // The worktree went, and its session with it.
    await expect(page.locator('.session-row')).toHaveCount(0);
    // The diff survived, frozen.
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('inspector')).toContainText('已凍結');
  });

  /**
   * The refusal that matters most: merging a branch that does not contain the
   * work, from a directory that is about to be removed.
   */
  test('a merge that would drop uncommitted work is refused, in full', async ({ page }) => {
    await withAttempt(page);
    await page.evaluate(() => window.__mock.dirtyWorktrees.add('k1-a1'));

    await page.getByTestId('merge-attempt').click();

    await expect(page.getByTestId('finish-error')).toContainText('沒有 commit');
    // Nothing was given up on the way to finding out.
    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('state-k1')).not.toHaveText(/已合併/);
    await expect(page.locator('.session-row')).toHaveCount(1);
  });

  /**
   * Opening a pull request deliberately leaves the attempt open: review is
   * exactly when there is still something to change, and the worktree is
   * where changing it happens.
   */
  test('opening a PR reports the URL and leaves the attempt running', async ({ page }) => {
    await withAttempt(page);
    await page.getByTestId('open-pr').click();

    await expect(page.getByTestId('pr-url')).toContainText('github.com/test/repo/pull/1');
    await expect(page.getByTestId('inspector')).not.toContainText('已凍結');
    await expect(page.locator('.session-row')).toHaveCount(1);
  });

  test('discarding takes the worktree back and keeps the record', async ({ page }) => {
    await withAttempt(page);
    await page.evaluate(() =>
      window.__mock.diffs.set('k1-a1', 'diff --git a/x b/x\n+half done\n'),
    );
    await page.getByTestId('discard-attempt').click();

    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('state-k1')).toHaveText(/已丟棄/);
    await expect(page.locator('.session-row')).toHaveCount(0);

    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-body')).toContainText('half done');
  });

  /** A finished attempt has nothing left to finish. */
  test('the finishing buttons are gone once an attempt has ended', async ({ page }) => {
    await withAttempt(page);
    await page.getByTestId('discard-attempt').click();
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();

    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('merge-attempt')).toHaveCount(0);
    await expect(page.getByTestId('open-pr')).toHaveCount(0);
  });

  /** Closing an attempt frees a slot, so the queue must move. */
  test('finishing an attempt lets a queued card start', async ({ page }) => {
    await boot(page, 1);
    await newCard(page, '第一張');
    await newCard(page, '第二張');
    await start(page, 'k1');
    await start(page, 'k2');
    await expect(page.getByTestId('state-k2')).toHaveText(/排隊中/);

    await page.getByTestId('inspect-k1').click();
    await page.getByTestId('merge-attempt').click();

    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('state-k1')).toHaveText(/已合併/);
    await expect(page.getByTestId('state-k2')).toHaveText(/等你確認資料夾/);
  });
});
