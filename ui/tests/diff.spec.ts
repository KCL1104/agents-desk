import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

/** Two ordinary files, so folding one leaves the other to compare against. */
const TWO_FILES = [
  'diff --git a/src/auth.py b/src/auth.py',
  '--- a/src/auth.py',
  '+++ b/src/auth.py',
  '@@ -1,3 +1,3 @@',
  ' def login():',
  '-    return None',
  '+    return session',
  'diff --git a/src/db.py b/src/db.py',
  '--- a/src/db.py',
  '+++ b/src/db.py',
  '@@ -1,2 +1,3 @@',
  ' def q():',
  '+    return conn',
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
  await expect(page.locator('.pane:visible')).toHaveCount(1);
}

async function openDiff(page: Page, diff: string) {
  await page.evaluate((d) => {
    window.__mock.diffs.set('k1-a1', d);
  }, diff);
  await page.getByTestId('view-board').click();
  await page.getByTestId('inspect-k1').click();
  await expect(page.getByTestId('diff-body')).toBeVisible();
}

test.describe('the suggested next step', () => {
  test('an idle card wears the one state-appropriate hint', async ({ page }) => {
    await boardWithAttempt(page);
    await page.evaluate(() => {
      window.__mock.stats.set('k1-a1', {
        files: 1, adds: 5, dels: 0, ahead: 2, behind: 0, dirty: false,
      });
      window.__mock.report('s1', 'idle');
    });
    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('next-k1')).toContainText('可以合併回 main');
  });

  test('a running agent is never nagged about its dirty worktree', async ({ page }) => {
    await boardWithAttempt(page);
    await page.evaluate(() => {
      window.__mock.stats.set('k1-a1', {
        files: 1, adds: 5, dels: 0, ahead: 0, behind: 0, dirty: true,
      });
      window.__mock.report('s1', 'running');
    });
    await page.getByTestId('view-board').click();
    await expect(page.getByTestId('stat-k1')).toBeVisible();
    await expect(page.getByTestId('next-k1')).toHaveCount(0);

    // The moment it stops being mid-work, the hint may speak.
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await expect(page.getByTestId('next-k1')).toContainText('未 commit');
  });

  test('the drawer runs the merge checks before the click', async ({ page }) => {
    await boardWithAttempt(page);
    await page.evaluate(() => {
      window.__mock.stats.set('k1-a1', {
        files: 1, adds: 5, dels: 0, ahead: 1, behind: 2, dirty: false,
      });
    });
    await openDiff(page, TWO_FILES);
    await expect(page.getByTestId('next-banner')).toContainText('先 rebase');
  });
});

test.describe('the diff viewer', () => {
  test('a wall of generated lines starts folded, one click away', async ({ page }) => {
    await boardWithAttempt(page);
    const wall = [
      'diff --git a/gen.lock b/gen.lock',
      '--- a/gen.lock',
      '+++ b/gen.lock',
      '@@ -0,0 +1,900 @@',
      ...Array.from({ length: 900 }, (_, i) => `+line ${i}`),
    ].join('\n');
    await openDiff(page, wall);

    await expect(page.getByTestId('diff-fold-0')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.diff-line.add')).toHaveCount(0);
    await page.getByTestId('diff-fold-0').click();
    await expect(page.locator('.diff-line.add')).toHaveCount(900);
  });

  test('a deleted file says nothing its header does not', async ({ page }) => {
    await boardWithAttempt(page);
    const gone = [
      'diff --git a/old.py b/old.py',
      'deleted file mode 100644',
      '--- a/old.py',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-a',
      '-b',
    ].join('\n');
    await openDiff(page, gone);
    await expect(page.getByTestId('diff-fold-0')).toHaveAttribute('aria-expanded', 'false');
  });

  test('viewed marks fold the file and survive the drawer closing', async ({ page }) => {
    await boardWithAttempt(page);
    await openDiff(page, TWO_FILES);

    await page.getByTestId('diff-viewed-0').click();
    await expect(page.getByTestId('viewed-count')).toContainText('已看 1/2');
    await expect(page.getByTestId('diff-fold-0')).toHaveAttribute('aria-expanded', 'false');
    // The other file is untouched.
    await expect(page.getByTestId('diff-fold-1')).toHaveAttribute('aria-expanded', 'true');

    // ⌘I away and back: progress through a half-walked review holds.
    await page.getByTestId('toggle-inspector').click();
    await expect(page.getByTestId('inspector')).toHaveCount(0);
    await page.getByTestId('toggle-inspector').click();
    await expect(page.getByTestId('viewed-count')).toContainText('已看 1/2');
    await expect(page.getByTestId('diff-fold-0')).toHaveAttribute('aria-expanded', 'false');
  });

  test('wrap is a toggle, and a remembered one', async ({ page }) => {
    await boardWithAttempt(page);
    await openDiff(page, TWO_FILES);

    await expect(page.getByTestId('diff-body')).not.toHaveClass(/wrap/);
    await page.getByTestId('diff-wrap').click();
    await expect(page.getByTestId('diff-body')).toHaveClass(/wrap/);
    const stored = await page.evaluate(() => localStorage.getItem('agentdesk.diffWrap'));
    expect(stored).toBe('1');
  });

  test('n and p walk the file headers as j and k walk the lines', async ({ page }) => {
    await boardWithAttempt(page);
    await openDiff(page, TWO_FILES);

    await page.getByTestId('diff-body').focus();
    await page.keyboard.press('n');
    await expect(page.getByTestId('diff-fold-0')).toBeFocused();
    await page.keyboard.press('n');
    await expect(page.getByTestId('diff-fold-1')).toBeFocused();
    await page.keyboard.press('p');
    await expect(page.getByTestId('diff-fold-0')).toBeFocused();

    // Enter on a header folds — the same key that comments on a line.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('diff-fold-0')).toHaveAttribute('aria-expanded', 'false');
  });

  test('the file jump reopens what the fold policy had away', async ({ page }) => {
    await boardWithAttempt(page);
    await openDiff(page, TWO_FILES);

    await page.getByTestId('diff-viewed-1').click();
    await expect(page.getByTestId('diff-fold-1')).toHaveAttribute('aria-expanded', 'false');

    await page.getByTestId('diff-jump').selectOption('1');
    await expect(page.getByTestId('diff-fold-1')).toHaveAttribute('aria-expanded', 'true');
  });

  test('the drawer edge drags, and the width is remembered', async ({ page }) => {
    await boardWithAttempt(page);
    await openDiff(page, TWO_FILES);

    const before = await page.getByTestId('inspector').boundingBox();
    const grip = page.getByTestId('inspector-grip');
    await grip.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    const after = await page.getByTestId('inspector').boundingBox();
    expect((after?.width ?? 0) - (before?.width ?? 0)).toBe(48);

    const stored = await page.evaluate(() =>
      Number(localStorage.getItem('agentdesk.inspectorWidth')),
    );
    expect(stored).toBe(Math.round(after?.width ?? 0));
  });
});
