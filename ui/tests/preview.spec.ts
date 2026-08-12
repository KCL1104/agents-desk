import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

/** A card with a started attempt and a dev script, drawer open. */
async function ready(page: Page, repo = '/Users/test/picked-repo') {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
  await page.evaluate((r) => {
    window.__mock.runScripts = ['dev'];
    window.__mock.repos[r] = ['main'];
  }, repo);
  await page.getByTestId('view-board').click();
  await page.getByRole('button', { name: '新增卡片', exact: true }).click();
  await page.getByTestId('task-title').fill('修好登入');
  await page.getByTestId('task-prompt').fill('把它修好');
  await page.getByTestId('task-repo').fill(repo);
  await page.getByTestId('task-branch').fill('main');
  await page.getByTestId('task-create').click();
  await page.locator('[data-testid="task-k1"] button.primary').click();
  await expect(page.getByTestId('attempt-prompt')).toBeVisible();
  await page.getByTestId('attempt-start').click();
  await page.getByTestId('view-board').click();
  await page.getByTestId('inspect-k1').click();
  await expect(page.getByTestId('inspector')).toBeVisible();
}

test.describe('dev server preview', () => {
  test('▶ dev earns a preview chip, and the chip hangs the page on the desk', async ({
    page,
  }) => {
    await ready(page);
    // No server yet: no chip — a button with nothing behind it is a lie.
    await expect(page.getByTestId('open-preview')).toHaveCount(0);

    await page.getByTestId('run-dev').click();
    // The ▶ landed us in the server's terminal; the chip lives in the
    // attempt's drawer, so walk back in through the board.
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await expect(page.getByTestId('open-preview')).toBeVisible();

    await page.getByTestId('open-preview').click();
    await expect(page.getByTestId('preview-panel')).toBeVisible();
    await expect(page.locator('.preview-frame')).toHaveAttribute(
      'src',
      'http://localhost:4173',
    );
    await expect(page.locator('.preview-url')).toHaveText('http://localhost:4173');
  });

  test('a dead server and an unreachable one both get words, never a blank frame', async ({
    page,
  }) => {
    await ready(page);
    await page.getByTestId('run-dev').click();
    // The ▶ landed us in the server's terminal; the chip lives in the
    // attempt's drawer, so walk back in through the board.
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await page.getByTestId('open-preview').click();
    await expect(page.locator('.preview-frame')).toBeVisible();

    // Nothing answering on the port: the cover says so and offers a retry.
    await page.evaluate(() => {
      window.__mock.portListening = false;
    });
    await page.getByTestId('preview-reload').click();
    await expect(page.getByTestId('preview-unreachable')).toContainText('沒有東西在監聽');
    await page.evaluate(() => {
      window.__mock.portListening = true;
    });
    await page.getByTestId('preview-unreachable').getByRole('button').click();
    await expect(page.locator('.preview-frame')).toBeVisible();

    // The server's terminal closes: the cover names that instead.
    await page.evaluate(() => {
      const s = window.__mock.sessions.find((x) => x.agent === 'sh');
      if (s) {
        s.live = false;
        s.status = 'exited';
      }
      window.__mock.emit('sessions:changed', window.__mock.sorted());
    });
    await expect(page.getByTestId('preview-dead')).toContainText('終端機已關閉');
  });

  test('an ssh attempt gets the disabled chip wearing its reason', async ({ page }) => {
    await ready(page, 'ssh://devbox/home/me/app');
    await page.getByTestId('run-dev').click();
    // The ▶ landed us in the server's terminal; the chip lives in the
    // attempt's drawer, so walk back in through the board.
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();

    const chip = page.getByTestId('open-preview');
    await expect(chip).toBeVisible();
    await expect(chip).toBeDisabled();
    await expect(chip).toHaveAttribute('title', /遠端主機/);
  });

  test('a pick speaks only from the preview’s origin, and telling the agent is a human click', async ({
    page,
  }) => {
    await ready(page);
    await page.evaluate(() => window.__mock.report('s1', 'idle'));
    await page.getByTestId('run-dev').click();
    // The ▶ landed us in the server's terminal; the chip lives in the
    // attempt's drawer, so walk back in through the board.
    await page.getByTestId('view-board').click();
    await page.getByTestId('inspect-k1').click();
    await page.getByTestId('open-preview').click();
    await expect(page.getByTestId('preview-panel')).toBeVisible();

    // A stranger's origin is ignored — the channel belongs to the page.
    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://evil.example',
          data: { type: 'marol:pick', component: 'X', file: 'x.tsx', line: 1 },
        }),
      );
    });
    await expect(page.getByTestId('preview-pick')).toHaveCount(0);

    await page.evaluate(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:4173',
          data: {
            type: 'marol:pick',
            component: 'LoginForm',
            file: 'src/auth/LoginForm.tsx',
            line: 42,
          },
        }),
      );
    });
    await expect(page.getByTestId('preview-pick')).toContainText(
      'LoginForm · src/auth/LoginForm.tsx:42',
    );

    // The words go to the agent only when a person sends them.
    await page.getByTestId('preview-tell').click();
    const call = await page.evaluate(
      () => window.__mock.calls.filter((c) => c.cmd === 'send_followup').at(-1)?.args,
    );
    expect(call).toMatchObject({ id: 's1' });
    expect(String((call as { text: string }).text)).toContain('src/auth/LoginForm.tsx');
    await expect(page.getByTestId('preview-pick')).toHaveCount(0);
  });
});
