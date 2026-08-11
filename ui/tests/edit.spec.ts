import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

/** Put the caret at the end of the document, in this platform's own words.
 *
 *  `Control+End` is the Windows and Linux chord; on macOS CodeMirror binds
 *  `Cmd-ArrowDown` for it instead. The suite had encoded one platform's
 *  keyboard for its whole life, so on a Mac the caret never moved, the text
 *  landed in the middle of the file, and the assertions failed for a reason
 *  that had nothing to do with saving. */
async function toDocEnd(page: Page) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
}

const DIFF = [
  'diff --git a/src/auth.py b/src/auth.py',
  'index 1111111..2222222 100644',
  '--- a/src/auth.py',
  '+++ b/src/auth.py',
  '@@ -1,2 +1,2 @@',
  ' def login():',
  '-    return None',
  '+    return session',
].join('\n');

const BASE = 'def login():\n    return None\n';
const WORK = 'def login():\n    return session\n';

/** A card, an attempt, and a settled worktree with one edited file. */
async function settledAttempt(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.getByTestId('view-board').click();

  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  await page.getByTestId('task-title').fill('修好登入');
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();

  await page.locator('[data-testid="task-k1"] button.primary').click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();

  await page.evaluate(
    ({ diff, base, work }) => {
      window.__mock.diffs.set('k1-a1', diff);
      window.__mock.files.set('k1-a1:src/auth.py', { base, work });
      // The turn is over: the edit chip's whole family appears.
      window.__mock.report('s1', 'idle');
    },
    { diff: DIFF, base: BASE, work: WORK },
  );
}

test.describe('editable diff', () => {
  /**
   * The 驗收 walk: change a line where it is being read, save, and the
   * worktree, the diff and the viewed mark all tell the truth about it —
   * then the agent is told, by a human hand, naming the file.
   */
  test('an edit saves into the worktree, refreshes the diff and resets viewed', async ({
    page,
  }) => {
    await settledAttempt(page);
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-body')).toContainText('src/auth.py');

    // Reviewed once — the mark the save must expire.
    await page.getByTestId('diff-viewed-0').click();
    await expect(page.getByTestId('viewed-count')).toBeVisible();

    await page.getByTestId('diff-edit-0').click();
    await expect(page.getByTestId('file-editor')).toBeVisible();
    // Both sides arrived: the worktree text is the document, the base copy
    // sits inline as the deleted chunk.
    await expect(page.locator('.file-editor .cm-content')).toContainText('return session');
    await expect(page.locator('.file-editor .cm-deletedChunk')).toContainText('return None');

    // Nothing changed yet, so there is nothing to save.
    await expect(page.getByTestId('editor-save')).toBeDisabled();

    await page.locator('.file-editor .cm-content').click();
    await toDocEnd(page);
    await page.keyboard.type('marker_one = 1');
    await expect(page.getByTestId('editor-save')).toBeEnabled();
    await page.getByTestId('editor-save').click();

    // The worktree file holds the edit.
    await expect
      .poll(() =>
        page.evaluate(() => window.__mock.files.get('k1-a1:src/auth.py')?.work ?? ''),
      )
      .toContain('marker_one');
    // The diff re-read counts the new state — the file's rows sit behind
    // the still-open editor — and "seen" has expired.
    await expect(page.locator('.diff-file .diff-count.add')).toHaveText('+3');
    await expect(page.getByTestId('viewed-count')).toHaveCount(0);

    // ⌘S is the same save. A second edit, saved by key alone — and pressed
    // the way this platform's user presses it, since that is the half of the
    // contract a Linux-only suite could never check.
    await page.locator('.file-editor .cm-content').click();
    await toDocEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('marker_two = 2');
    await page.keyboard.press('ControlOrMeta+s');
    await expect
      .poll(() =>
        page.evaluate(() => window.__mock.files.get('k1-a1:src/auth.py')?.work ?? ''),
      )
      .toContain('marker_two');

    // The pre-composed note goes through the human's click, and it names
    // the file the agent must re-read.
    await page.getByTestId('editor-tell').click();
    const note = await page.evaluate(
      () => window.__mock.calls.find((c) => c.cmd === 'send_followup')?.args,
    );
    expect(String((note as { text: string }).text)).toContain('src/auth.py');

    // Closing the clean editor gives the floor back to the refreshed rows.
    await page.getByTestId('editor-close').click();
    await expect(page.getByTestId('file-editor')).toHaveCount(0);
    await expect(page.getByTestId('diff-body')).toContainText('+marker_one = 1');
    await expect(page.getByTestId('diff-body')).toContainText('+marker_two = 2');
  });

  /**
   * Two layers, both real: mid-turn the chip is not offered, and an editor
   * already open when the turn starts is refused by the core with the whole
   * reason — the UI hiding a button is not the guard.
   */
  test('mid-turn the chip hides and a save is refused by the core in full', async ({
    page,
  }) => {
    await settledAttempt(page);
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-edit-0')).toBeVisible();

    // The turn starts: the whole chip family goes, park included.
    await page.evaluate(() => window.__mock.report('s1', 'running'));
    await expect(page.getByTestId('diff-edit-0')).toHaveCount(0);
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await expect(page.getByTestId('diff-edit-0')).toBeVisible();

    // Editor open, then the agent starts a turn underneath it.
    await page.getByTestId('diff-edit-0').click();
    await page.locator('.file-editor .cm-content').click();
    await page.keyboard.type('late');
    await page.evaluate(() => window.__mock.report('s1', 'running'));

    await page.getByTestId('editor-save').click();
    // The refusal, verbatim and complete — what happened and what to do.
    await expect(page.getByTestId('editor-error')).toContainText('mid-turn');
    await expect(page.getByTestId('editor-error')).toContainText('Wait for the turn to end');
    // The typed text is not punished for the refusal.
    await expect(page.getByTestId('file-editor')).toBeVisible();
    await expect(page.locator('.file-editor .cm-content')).toContainText('late');
  });

  /** A record is not a document: frozen and parked diffs offer no way in. */
  test('frozen and parked diffs have no edit entry', async ({ page }) => {
    await settledAttempt(page);

    // Parked first — the same attempt can still resume afterwards.
    await page.evaluate(() =>
      (window.__TAURI_INTERNALS__ as unknown as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>;
      }).invoke('park_attempt', { attemptId: 'k1-a1' }),
    );
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('diff-body')).toContainText('src/auth.py');
    await expect(page.locator('.diff-edit')).toHaveCount(0);

    // Finished: the frozen diff is the record.
    await page.evaluate(async () => {
      const tauri = window.__TAURI_INTERNALS__ as unknown as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>;
      };
      await tauri.invoke('resume_attempt', { attemptId: 'k1-a1', cols: 100, rows: 30 });
      await tauri.invoke('finish_attempt', { attemptId: 'k1-a1', outcome: 'discarded' });
    });
    await expect(page.getByTestId('diff-body')).toContainText('src/auth.py');
    await expect(page.locator('.diff-edit')).toHaveCount(0);
  });

  /**
   * The freshness contract: an editor whose disk moved underneath it — a
   * shell, a script, a later turn — is refused instead of silently
   * overwriting that work. Last-write-wins is how edits vanish unseen.
   */
  test('a save over a file that changed on disk is refused with the reason', async ({
    page,
  }) => {
    await settledAttempt(page);
    await page.getByTestId('inspect-k1').click();
    await page.getByTestId('diff-edit-0').click();
    await page.locator('.file-editor .cm-content').click();
    await page.keyboard.type('mine');

    // Someone else writes while the editor sits open.
    await page.evaluate(() => {
      const entry = window.__mock.files.get('k1-a1:src/auth.py')!;
      entry.work = 'def login():\n    return other_work\n';
    });

    await page.getByTestId('editor-save').click();
    await expect(page.getByTestId('editor-error')).toContainText('changed on disk');
    // The typed text survives the refusal — nothing was thrown away.
    await expect(page.locator('.file-editor .cm-content')).toContainText('mine');
  });

  /** The header chips' keyboard: on a focused file header, e opens the
      editor and v toggles viewed — the walk never needs the mouse. */
  test('e and v act on the focused file header', async ({ page }) => {
    await settledAttempt(page);
    await page.getByTestId('inspect-k1').click();
    const body = page.getByTestId('diff-body');
    await body.click();

    // n lands on the file header; v marks it viewed and folds it.
    await page.keyboard.press('n');
    await page.keyboard.press('v');
    await expect(page.getByTestId('viewed-count')).toBeVisible();
    await page.keyboard.press('v');
    await expect(page.getByTestId('viewed-count')).toHaveCount(0);

    // e opens the in-place editor; Esc inside it asks through the same
    // dirty guard the Close chip uses (clean here, so it just closes).
    await page.keyboard.press('e');
    await expect(page.getByTestId('file-editor')).toBeVisible();
    await page.locator('.file-editor .cm-content').click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('file-editor')).toHaveCount(0);
  });

  /** A pending comment outlives the line it quoted; it wears the fact. */
  test('a comment whose line left the diff is marked stale', async ({ page }) => {
    await settledAttempt(page);
    await page.getByTestId('inspect-k1').click();

    // Comment on the context line — the one whose rendered text will not
    // reappear once the mock re-renders the file as a full replacement.
    // (Context lines carry no variant class; the first commentable line
    // of this fixture is the context line ` def login():`.)
    await page.locator('.diff-line.commentable').first().click();
    await page.getByTestId('review-note').fill('這行有問題');
    await page.getByTestId('review-add').click();
    await expect(page.locator('.review-pending li')).toHaveCount(1);
    await expect(page.locator('.review-stale')).toHaveCount(0);

    // The worktree moves on: an edit replaces the quoted line, the diff
    // is re-read, and the note's anchor is history.
    await page.getByTestId('diff-edit-0').click();
    await page.locator('.file-editor .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('replacement = 1');
    await page.getByTestId('editor-save').click();
    await expect(page.locator('.review-stale')).toBeVisible();
  });

  /** Typed text is never lost to a click that meant something milder. */
  test('closing with unsaved changes asks first, through every door', async ({ page }) => {
    await settledAttempt(page);
    await page.getByTestId('inspect-k1').click();
    await page.getByTestId('diff-edit-0').click();
    await page.locator('.file-editor .cm-content').click();
    await page.keyboard.type('precious');

    // The Close chip hits the guard; keeping means keeping everything.
    await page.getByTestId('editor-close').click();
    await expect(page.getByRole('dialog')).toContainText('有未存的變更');
    await page.getByTestId('editor-keep').click();
    await expect(page.locator('.file-editor .cm-content')).toContainText('precious');

    // The file's own fold button is a close in disguise — same guard.
    await page.getByTestId('diff-fold-0').click();
    await expect(page.getByRole('dialog')).toContainText('有未存的變更');

    // Discarding closes the editor and writes nothing.
    await page.getByTestId('editor-discard').click();
    await expect(page.getByTestId('file-editor')).toHaveCount(0);
    await expect(page.locator('.diff-line.add').first()).toBeVisible();
    const work = await page.evaluate(
      () => window.__mock.files.get('k1-a1:src/auth.py')?.work ?? '',
    );
    expect(work).not.toContain('precious');

    // Clean again: the same door closes without a question.
    await page.getByTestId('diff-edit-0').click();
    await expect(page.getByTestId('file-editor')).toBeVisible();
    await page.getByTestId('editor-close').click();
    await expect(page.getByTestId('file-editor')).toHaveCount(0);
  });
});
