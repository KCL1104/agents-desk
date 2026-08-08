import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

const DIFF = [
  'diff --git a/src/auth.py b/src/auth.py',
  'index 1111111..2222222 100644',
  '--- a/src/auth.py',
  '+++ b/src/auth.py',
  '@@ -1,3 +1,3 @@',
  ' def login():',
  '-    return None',
  '+    return session',
].join('\n');

async function boardWithAttempt(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.getByTestId('view-board').click();

  await page.getByRole('button', { name: '新增卡片' }).click();
  await page.getByTestId('task-title').fill('修好登入');
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();

  await page.locator('[data-testid="task-k1"] button.primary').click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();
}

test.describe('attempt inspector', () => {
  /**
   * The acceptance for M3: say what this attempt changed and what it did,
   * without reading its terminal.
   */
  test('says what changed and what the agent did, without the TUI', async ({ page }) => {
    await boardWithAttempt(page);
    await page.evaluate((diff) => {
      window.__mock.diffs.set('k1-a1', diff);
      window.__mock.record('k1-a1', 'tool', 'Bash', 'pytest tests/test_auth.py -v');
      window.__mock.record('k1-a1', 'tool', 'Edit', '/repo/src/auth.py');
      window.__mock.record('k1-a1', 'status', null, 'idle');
    }, DIFF);

    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('inspector')).toBeVisible();

    // What changed.
    const body = page.getByTestId('diff-body');
    await expect(body).toContainText('src/auth.py');
    await expect(body).toContainText('+    return session');
    // Additions and removals are told apart, and the +++/--- file headers are
    // not mistaken for them.
    await expect(page.locator('.diff-line.add')).toHaveCount(1);
    await expect(page.locator('.diff-line.del')).toHaveCount(1);
    // The +++/--- plumbing folds into the file chip: name, weight, and the
    // raw header a hover away — four rows of a 460px drawer say it in one.
    await expect(page.locator('.diff-line.meta')).toHaveCount(0);
    await expect(page.locator('.diff-file')).toContainText('src/auth.py');
    await expect(page.locator('.diff-file-name')).toHaveAttribute('title', /diff --git/);

    // What it did.
    await page.getByTestId('inspector-timeline-tab').click();
    const rows = page.locator('.tl-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('[AgentDesk 任務]');
    await expect(rows.nth(1)).toContainText('pytest tests/test_auth.py -v');
    await expect(rows.nth(2)).toContainText('/repo/src/auth.py');
    await expect(rows.nth(3)).toContainText('待命');
  });

  /**
   * The drawer sits beside the terminal, never instead of it. Reviewing ends
   * either in accepting the work or telling the agent what is still wrong,
   * and the second has to be typing rather than navigating — that is the
   * whole difference between this and a board with a diff viewer bolted on.
   */
  test('opens beside the live terminal, which stays usable', async ({ page }) => {
    await boardWithAttempt(page);
    await page.getByTestId('inspect-k1').click();

    // Both on screen at once.
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();

    // The terminal still takes the caret, so a follow-up is just typed.
    await page.locator('.pane[data-session-id="s1"] .term-host').click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const pane = document.querySelector('.pane[data-session-id="s1"]');
          return !!pane && !!document.activeElement && pane.contains(document.activeElement);
        }),
      )
      .toBe(true);

    await page.keyboard.type('還是壞的');
    const typed = await page.evaluate(() =>
      window.__mock.calls.filter((c) => c.cmd === 'term_write').length,
    );
    expect(typed).toBeGreaterThan(0);
  });

  test('closing the drawer leaves the terminal where it was', async ({ page }) => {
    await boardWithAttempt(page);
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('inspector')).toBeVisible();

    await page.getByRole('button', { name: '關閉檢視' }).click();
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();

    // And the topbar toggle brings it back.
    await page.getByTestId('toggle-inspector').click();
    await expect(page.getByTestId('inspector')).toBeVisible();
  });

  test('an attempt that has changed nothing says so rather than showing a blank', async ({
    page,
  }) => {
    await boardWithAttempt(page);
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-empty')).toBeVisible();
  });

  /**
   * Once the outcome is set the worktree is gone, so this is the only copy of
   * the diff there will ever be. Being able to read it is the whole reason a
   * superseded attempt is kept at all.
   */
  test('a finished attempt still shows the diff frozen before its worktree went', async ({
    page,
  }) => {
    await boardWithAttempt(page);
    await page.evaluate(() => window.__mock.record('k1-a1', 'tool', 'Bash', 'cargo test'));

    await page.evaluate(async () => {
      await (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__.invoke('finish_attempt', {
        attemptId: 'k1-a1',
        outcome: 'merged',
      });
    });

    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('state-k1')).toHaveText(/已合併/);
    // Its session is gone with its worktree.
    await expect(page.locator('.pane[data-session-id="s1"]')).toHaveCount(0);

    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('inspector')).toContainText('已凍結');
    await expect(page.getByTestId('diff-body')).toContainText('+fixed');

    // And its record of what it did survives too.
    await page.getByTestId('inspector-timeline-tab').click();
    await expect(page.locator('.tl-row')).toContainText(['[AgentDesk 任務]', 'cargo test']);
  });

  /**
   * Reading one attempt's diff while looking at another's terminal is the one
   * arrangement here that could actively mislead.
   */
  test('the drawer follows the terminal you move to', async ({ page }) => {
    await boardWithAttempt(page);
    await page.evaluate(() => {
      window.__mock.diffs.set('k1-a1', 'diff --git a/one b/one\n+first attempt\n');
    });

    // A second attempt at the same card, with its own worktree and diff. The
    // first is left running — comparing two agents is the reason to have both.
    await page.getByTestId('retry-k1').click();
    await page.getByTestId('attempt-start').click();
    await page.evaluate(() => {
      window.__mock.diffs.set('k1-a2', 'diff --git a/two b/two\n+second attempt\n');
    });

    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-body')).toContainText('second attempt');

    // Click back onto the first attempt's pane; the drawer must follow.
    await page.locator('.pane[data-session-id="s1"]').click();
    await expect(page.getByTestId('diff-body')).toContainText('first attempt');
  });

  test('the refresh button re-reads a worktree that has moved on', async ({ page }) => {
    await boardWithAttempt(page);
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-empty')).toBeVisible();

    // The agent keeps working while you are reading.
    await page.evaluate(() =>
      window.__mock.diffs.set('k1-a1', 'diff --git a/late b/late\n+arrived later\n'),
    );
    // Deliberately not on a timer: a diff that reflows while you read it is
    // worse than one you asked to refresh.
    await expect(page.getByTestId('diff-empty')).toBeVisible();

    await page.getByRole('button', { name: '重新讀取' }).click();
    await expect(page.getByTestId('diff-body')).toContainText('arrived later');
  });

  test('an ad-hoc session has nothing to inspect', async ({ page }) => {
    await page.addInitScript(installMock);
    await page.goto('/');
    await expect(page.locator('.tab')).toHaveCount(1);

    await page.locator('.sidebar-head button.icon').click();
    await page.locator('.modal input.mono').first().fill('/Users/test/scratch');
    await page.locator('.modal button.primary').click();

    await expect(page.locator('.pane[data-session-id="s1"]')).toBeVisible();
    await expect(page.getByTestId('toggle-inspector')).toHaveCount(0);
  });
});
