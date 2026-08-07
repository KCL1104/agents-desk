import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';
import { en, zhTW } from '../src/i18n/messages';

/**
 * The language switch, end to end.
 *
 * Everything else in the suite pins the locale to Chinese so its assertions
 * mean something; this file is the one place that changes it on purpose, so
 * that the picker, the persistence and the backend hand-off are all actually
 * exercised rather than assumed.
 */

/** Open the app with a chosen starting language, or with none set at all. */
async function boot(page: Page, opts: { stored?: string; browserLang?: string } = {}) {
  await page.addInitScript(installMock);
  await page.addInitScript(
    ({ stored, browserLang }) => {
      // Init scripts re-run on reload, so the starting language is applied
      // once per context. Without the sentinel this helper would re-pin the
      // language every load and quietly undo the switch under test.
      if (!sessionStorage.getItem('__localePinned')) {
        sessionStorage.setItem('__localePinned', '1');
        if (stored === undefined) localStorage.removeItem('agentdesk.locale');
        else localStorage.setItem('agentdesk.locale', stored);
      }
      if (browserLang) {
        // Configurable, so a test that boots twice can redefine it instead of
        // throwing on the second pass.
        const opts = { configurable: true };
        Object.defineProperty(navigator, 'languages', { ...opts, get: () => [browserLang] });
        Object.defineProperty(navigator, 'language', { ...opts, get: () => browserLang });
      }
    },
    { stored: opts.stored, browserLang: opts.browserLang },
  );
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
}

const openEnvPanel = (page: Page) => page.getByRole('button', { name: /環境|Environment/ }).click();

test.describe('language', () => {
  test('an English system with no stored choice opens in English', async ({ page }) => {
    await boot(page, { stored: undefined, browserLang: 'en-US' });
    await expect(page.getByRole('tab', { name: 'Board' })).toBeVisible();
  });

  test('a Chinese system with no stored choice opens in Chinese', async ({ page }) => {
    await boot(page, { stored: undefined, browserLang: 'zh-TW' });
    await expect(page.getByRole('tab', { name: '看板' })).toBeVisible();
  });

  test('a stored choice beats the browser locale', async ({ page }) => {
    // The one thing the user said out loud has to win, even on an English system.
    await boot(page, { stored: 'zh-TW', browserLang: 'en-US' });
    await expect(page.getByRole('tab', { name: '看板' })).toBeVisible();
  });

  test('switching re-renders the interface and survives a reload', async ({ page }) => {
    await boot(page, { stored: 'zh-TW' });
    await expect(page.getByRole('tab', { name: '看板' })).toBeVisible();

    await openEnvPanel(page);
    await page.getByTestId('locale-select').selectOption('en');

    // The panel itself is translated live, not only on the next mount.
    await expect(page.getByRole('heading', { name: 'Environment' })).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('tab', { name: 'Board' })).toBeVisible();
    await expect(page.getByRole('tab', { name: '看板' })).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('tab', { name: 'Board' })).toBeVisible();
  });

  test('the choice is pushed to the backend so native notifications match', async ({ page }) => {
    await boot(page, { stored: 'zh-TW' });
    await openEnvPanel(page);
    await page.getByTestId('locale-select').selectOption('en');
    await expect(page.getByRole('heading', { name: 'Environment' })).toBeVisible();

    const sent = await page.evaluate(() =>
      window.__mock.calls.filter((c) => c.cmd === 'set_locale').map((c) => c.args),
    );
    // Both the language it opened in and the one just picked: a user whose
    // system is already Chinese never touches the picker, and their
    // notifications still have to be Chinese.
    expect(sent).toContainEqual({ locale: 'zh-TW' });
    expect(sent).toContainEqual({ locale: 'en' });
  });

  test('every key is translated in both languages', async () => {
    // The types already reject a key missing from one catalogue. This catches
    // the other half: a key present but left as a copy of the English.
    expect(new Set(Object.keys(zhTW))).toEqual(new Set(Object.keys(en)));

    // Terms the interface deliberately says the same way in both languages,
    // because they are the words the tools themselves use.
    const SHARED = new Set([
      'newTask.repo',
      'attempt.agent',
      'env.shell',
      'env.claude',
      'env.sourceLogin',
    ]);
    const untranslated = (Object.keys(en) as Array<keyof typeof en>).filter(
      (k) => zhTW[k] === en[k] && !SHARED.has(k),
    );
    expect(untranslated).toEqual([]);
  });
});
