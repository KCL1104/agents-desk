import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

const REPO = '/Users/test/picked-repo';

async function appWithMock(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
}

async function cardOnBoard(page: Page) {
  await page.getByTestId('view-board').click();
  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  await page.getByTestId('task-title').fill('修好登入');
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(REPO);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
}

test.describe('named profiles', () => {
  /**
   * The whole loop: make a profile in the environment panel, and both the
   * saved list and the launch dialogs know it. The dialogs render the
   * backend's launcher list — the profile appearing there without any
   * frontend knowledge of it is the point.
   */
  test('a profile made in the panel appears in the launch dialogs', async ({ page }) => {
    await appWithMock(page);

    await page.locator('.sidebar-foot').click();
    await page.getByTestId('sec-agents').click();
    await expect(page.getByTestId('profiles')).toBeVisible();
    await page.getByTestId('profile-add').click();
    await page.getByTestId('profile-name-0').fill('opus 版');
    await page.getByTestId('profile-args-0').fill('--model opus');
    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-save')).toHaveText('已儲存 ✓');

    const stored = await page.evaluate(() => window.__mock.profiles);
    expect(stored).toEqual([{ name: 'opus 版', agent: 'claude', args: ['--model', 'opus'] }]);

    await page.getByRole('button', { name: '關閉' }).click();

    // The attempt dialog offers it, named, with the CLI it resolves to.
    await cardOnBoard(page);
    await page.locator('[data-testid="task-k1"] button.primary').click();
    await expect(
      page.getByTestId('attempt-agent').locator('option', { hasText: 'opus 版 · claude' }),
    ).toHaveCount(1);

    // Picking it keeps every claude convention: the prompt will be sent,
    // and the permission-mode choice is offered.
    await page.getByTestId('attempt-agent').selectOption('opus 版');
    await expect(page.getByTestId('attempt-mode')).toBeVisible();
    await expect(page.getByTestId('attempt-manual')).toHaveCount(0);

    await page.getByTestId('attempt-start').click();
    const call = await page.evaluate(
      () => window.__mock.calls.find((c) => c.cmd === 'open_attempt')?.args,
    );
    // The backend receives the *name*; resolution is its job.
    expect((call as { agent: string }).agent).toBe('opus 版');

    // What actually runs — and what the card says — is the CLI underneath.
    await page.getByTestId('view-board').click();
    await expect(page.locator('[data-testid="task-k1"] .ov-agent')).toHaveText('claude');
  });

  /** The backend refuses a set that cannot be offered, and the refusal is
      shown where it can be fixed. */
  test('a profile shadowing an agent name is refused where the person can see it', async ({
    page,
  }) => {
    await appWithMock(page);
    await page.locator('.sidebar-foot').click();
    await page.getByTestId('sec-agents').click();
    await page.getByTestId('profile-add').click();
    await page.getByTestId('profile-name-0').fill('claude');
    await page.getByTestId('profile-save').click();

    await expect(page.getByTestId('profile-error')).toContainText('claude');
    const stored = await page.evaluate(() => window.__mock.profiles);
    expect(stored).toEqual([]);
  });

  /** One save contract for the whole list: removal is a draft like any
      other edit, so a mis-clicked ✕ commits nothing until 儲存設定檔 —
      and until then, a stray backdrop click cannot discard the change. */
  test('a removed profile leaves when the list is saved, not before', async ({ page }) => {
    await appWithMock(page);
    await page.evaluate(() => {
      window.__mock.profiles = [{ name: 'opus 版', agent: 'claude', args: [] }];
    });

    await page.locator('.sidebar-foot').click();
    await page.getByTestId('sec-agents').click();
    await page.getByRole('button', { name: '移除這個設定檔' }).click();
    await expect(page.getByTestId('profiles')).not.toContainText('opus 版');

    // Still a draft: nothing persisted, and the dirty panel refuses the
    // backdrop the same way a typed dialog does.
    expect(await page.evaluate(() => window.__mock.profiles)).toEqual([
      { name: 'opus 版', agent: 'claude', args: [] },
    ]);
    await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.modal')).toBeVisible();

    await page.getByTestId('profile-save').click();
    await expect(page.getByTestId('profile-save')).toHaveText('已儲存 ✓');
    expect(await page.evaluate(() => window.__mock.profiles)).toEqual([]);
  });
});
