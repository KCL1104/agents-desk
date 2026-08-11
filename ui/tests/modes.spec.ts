import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boardWithCard(page: Page) {
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
}

test.describe('permission modes', () => {
  /**
   * The auto-accept switch, offered where the safety argument holds: an
   * attempt in its own worktree. Choosing yolo says so before starting, the
   * chosen mode reaches the backend, and the card wears it openly.
   */
  test('yolo is chosen with its eyes open and worn on the card', async ({ page }) => {
    await boardWithCard(page);

    await page.getByTestId('attempt-mode').selectOption('yolo');
    // The warning names both the power and the fence around it.
    await expect(page.getByTestId('yolo-hint')).toContainText('worktree');

    await page.getByTestId('attempt-start').click();
    await page.getByTestId('view-board').click();

    const call = await page.evaluate(
      () => window.__mock.calls.find((c) => c.cmd === 'open_attempt')?.args,
    );
    expect((call as { mode: string }).mode).toBe('yolo');

    // The badge: quiet autonomy that looked like supervision would be worse
    // than either.
    await expect(page.getByTestId('mode-k1')).toBeVisible();
    // Drawn, not the unicode ⚡ — the emoji-font roulette is the reason.
    await expect(page.getByTestId('mode-k1').locator('.icon-glyph')).toBeVisible();
    await expect(page.getByTestId('mode-k1')).toHaveClass(/yolo/);
  });

  test('the default asks as usual and wears no badge', async ({ page }) => {
    await boardWithCard(page);
    await page.getByTestId('attempt-start').click();
    await page.getByTestId('view-board').click();

    const call = await page.evaluate(
      () => window.__mock.calls.find((c) => c.cmd === 'open_attempt')?.args,
    );
    expect((call as { mode: string }).mode).toBe('normal');
    await expect(page.getByTestId('mode-k1')).toHaveCount(0);
  });

  /**
   * Only a measured CLI's permission flags exist, so only its sessions get
   * the choice — and a mode picked for one must not ride silently into a CLI
   * it was never measured against.
   */
  test('an unmeasured CLI gets no mode choice, and a picked mode does not follow it', async ({
    page,
  }) => {
    await boardWithCard(page);

    await page.getByTestId('attempt-mode').selectOption('yolo');
    await page.getByTestId('attempt-agent').selectOption('gemini');
    await expect(page.getByTestId('attempt-mode')).toHaveCount(0);

    await page.getByTestId('attempt-start').click();
    const call = await page.evaluate(
      () => window.__mock.calls.find((c) => c.cmd === 'open_attempt')?.args,
    );
    expect((call as { mode: string }).mode).toBe('normal');
  });

  /**
   * The other side of the same rule: a CLI whose flags *are* measured keeps
   * the choice when you switch to it, and the mode reaches the backend
   * unchanged. The two CLIs spell a mode differently — a permission mode
   * against a sandbox and an approval policy — and which spelling goes on
   * the command line is the backend's business, not this dialog's. What the
   * dialog owes is that the choice does not quietly vanish.
   */
  test('switching between measured CLIs keeps the mode choice and the mode', async ({
    page,
  }) => {
    await boardWithCard(page);

    await page.getByTestId('attempt-mode').selectOption('accept_edits');
    await page.getByTestId('attempt-agent').selectOption('codex');
    await expect(page.getByTestId('attempt-mode')).toBeVisible();
    await expect(page.getByTestId('attempt-mode')).toHaveValue('accept_edits');
    await expect(page.getByTestId('accept-hint')).toBeVisible();

    // And the prompt still goes in on the command line — the second
    // measured CLI is measured for that too.
    await expect(page.getByTestId('attempt-manual')).toHaveCount(0);

    await page.getByTestId('attempt-start').click();
    const call = await page.evaluate(
      () => window.__mock.calls.find((c) => c.cmd === 'open_attempt')?.args,
    );
    expect(call as { mode: string; agent: string }).toMatchObject({
      mode: 'accept_edits',
      agent: 'codex',
    });
  });
});
