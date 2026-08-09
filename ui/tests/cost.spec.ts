import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function boardWithAttempt(page: Page, agent: string) {
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
  if (agent !== 'claude') {
    await page.getByTestId('attempt-agent').selectOption(agent);
  }
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();
}

test.describe('the token account', () => {
  /**
   * The acceptance from the decision doc: once a turn's end has read the
   * transcript, the inspector wears the account — context and output,
   * compacted — with the exact four-way breakdown one hover away. Until
   * then, nothing: absence is a statement, not a bug.
   */
  test('the inspector wears the account once a read has landed', async ({ page }) => {
    await boardWithAttempt(page, 'claude');
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('inspector')).toBeVisible();

    // No read yet — no numbers, and no zero pretending to be one.
    await expect(page.getByTestId('inspector-usage')).toHaveCount(0);

    // The core's turn-end read lands on the session and broadcasts.
    await page.evaluate(() => {
      const s = window.__mock.sessions.find((x) => x.id === 's1')!;
      s.usage = {
        input: 99581,
        output: 2627380,
        cache_read: 780967984,
        cache_write: 35795023,
        context: 278599,
      };
      window.__mock.pushSessions();
    });

    const chip = page.getByTestId('inspector-usage');
    await expect(chip).toHaveText('語境 279k · ↑2.6M');
    // The tooltip holds the exact figures the compact form rounds away.
    await expect(chip).toHaveAttribute('title', /278,599/);
    await expect(chip).toHaveAttribute('title', /780,967,984/);
  });

  /** No transcript, no numbers: a codex session never grows an account. */
  test('an agent with no transcript shows nothing rather than a zero', async ({ page }) => {
    await boardWithAttempt(page, 'codex');
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('inspector')).toBeVisible();
    await expect(page.getByTestId('inspector-usage')).toHaveCount(0);
  });
});
