import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  LINES,
  MEDIA,
  TEST_LOG,
  TITLES,
  feedTui,
  mediaPage,
  repaintTerminals,
  seedWorld,
  type MediaLocale,
} from './media';

/**
 * README stills, staged on the real UI.
 *
 * Not part of the suite: these run only under SHOTS=1 and write PNGs into
 * docs/media/. The world they are shot in lives in `media.ts`, shared with
 * the per-feature recordings so the two can never show different products.
 */

/** The board, columns only. The hover peek is skipped on purpose: it
    clamps to 520px (~65 cols), under the TUI frame's measured wrap
    threshold (~88 cols) — a shredded terminal would sell dishonesty. */
async function stageBoard(page: Page) {
  await page.getByTestId('view-board').click();
  await page.waitForTimeout(900);
}

/** The drawer on k1: diff, one pending comment, the in-place editor open. */
async function stageInspector(page: Page, locale: MediaLocale) {
  await page.getByTestId('view-board').click();
  // Open the peek deliberately before aiming at the button: hovering the
  // card slides the peek in and every column shifts left — a click aimed
  // pre-shift lands on the card that moved out from under it.
  await page.getByTestId('task-k1').hover();
  await page.waitForTimeout(900);
  await page.getByTestId('inspect-k1').click();
  await expect(page.getByTestId('inspector')).toBeVisible();
  await expect(page.getByTestId('diff-body')).toContainText('session.py');
  // The attempt's own terminal opened beside the drawer; a black pane
  // beside a full drawer would read as broken. Same real TUI frame.
  await feedTui(page, 's101');
  // One comment pending on the stale-redirect line.
  await page.locator('.diff-line.del').first().click();
  await page.getByTestId('review-note').fill(LINES[locale].review);
  await page.getByTestId('review-add').click();
  // The second file marked viewed — the review has progress.
  await page.getByTestId('diff-viewed-1').click();
  // The editor, open on the file being fixed.
  await page.getByTestId('diff-edit-0').click();
  await expect(page.getByTestId('file-editor')).toBeVisible();
  await page.waitForTimeout(400);
}

test.describe('README media', () => {
  test.skip(process.env.SHOTS !== '1', 'run with SHOTS=1 to produce README media');

  for (const locale of ['en', 'zh-TW'] as const) {
    const tag = locale === 'en' ? 'en' : 'zh';
    const shot = (name: string) => join(MEDIA, `${name}.${tag}.png`);

    test(`board hero (${locale})`, async ({ browser }) => {
      mkdirSync(MEDIA, { recursive: true });
      const page = await mediaPage(browser, locale, { width: 1280, height: 800 });
      await seedWorld(page, locale, 'running');
      await stageBoard(page);
      await page.screenshot({ path: shot('board') });
      await page.context().close();
    });

    test(`inspector with the editable diff (${locale})`, async ({ browser }) => {
      // Wide enough that the pane beside a 600px drawer stays over the
      // frame's ~88-col wrap threshold.
      const page = await mediaPage(browser, locale, { width: 1760, height: 780 }, 1);
      await seedWorld(page, locale, 'idle');
      await stageInspector(page, locale);
      await page.screenshot({ path: shot('inspector') });
      await page.context().close();
    });

    test(`terminal wall (${locale})`, async ({ browser }) => {
      // Two panes at ~88 cols each — the measured no-wrap floor.
      const page = await mediaPage(browser, locale, { width: 1500, height: 640 }, 1);
      // Two ad-hoc sessions through the real dialog — selectors are
      // locale-free (classes, not names).
      for (const cwd of ['/Users/dev/agents-desk', '/Users/dev/webapp']) {
        await page.locator('.sidebar-head button.icon').click();
        await page.locator('.modal input.mono').first().fill(cwd);
        await page.locator('.modal button.primary').click();
        await expect(page.locator('.modal')).toHaveCount(0);
      }
      await expect(page.locator('.term-host:visible')).toHaveCount(2);
      await page.evaluate((tabName) => {
        window.__mock.tabs[0].name = tabName;
        window.__mock.emit('tabs:changed', window.__mock.tabs);
        window.__mock.report('s1', 'waiting_permission');
        window.__mock.report('s2', 'running', { tool: 'Bash', detail: 'npx vitest run' });
      }, TITLES[locale][6]);
      await page.waitForTimeout(400);
      await feedTui(page, 's1');
      await page.evaluate(
        // Encoded here, not with btoa in the page: the log carries ✓ and
        // box glyphs, which are beyond btoa's Latin-1 and exactly the
        // UTF-8 bytes xterm's decoder is built to eat.
        (log) => window.__mock.feed('s2', log, 1),
        Buffer.from(TEST_LOG).toString('base64'),
      );
      await page.waitForTimeout(900);
      await repaintTerminals(page);
      await page.screenshot({ path: shot('wall') });
      await page.context().close();
    });

    test(`overview (${locale})`, async ({ browser }) => {
      const page = await mediaPage(browser, locale, { width: 1280, height: 800 });
      await seedWorld(page, locale, 'running');
      // ⌘/Ctrl+3 rather than a click: the overview tab carries no testid,
      // and the shortcut is what a person reaches for anyway.
      await page.keyboard.press('ControlOrMeta+3');
      await expect(page.locator('.overview')).toBeVisible();
      await page.waitForTimeout(700);
      await page.screenshot({ path: shot('overview') });
      await page.context().close();
    });

    test(`command palette (${locale})`, async ({ browser }) => {
      const page = await mediaPage(browser, locale, { width: 1280, height: 800 });
      await seedWorld(page, locale, 'running');
      await page.getByTestId('view-board').click();
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByTestId('palette')).toBeVisible();
      // Nothing typed: the point of the frame is what it offers unasked.
      await page.waitForTimeout(500);
      await page.screenshot({ path: shot('palette') });
      await page.context().close();
    });

    test(`settings (${locale})`, async ({ browser }) => {
      const page = await mediaPage(browser, locale, { width: 1280, height: 800 });
      await seedWorld(page, locale, 'idle');
      await page.keyboard.press('ControlOrMeta+,');
      await expect(page.getByTestId('settings-body')).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({ path: shot('settings') });
      await page.context().close();
    });

    test(`timeline and checkpoints (${locale})`, async ({ browser }) => {
      const page = await mediaPage(browser, locale, { width: 1280, height: 820 }, 2, {
        drawer: 560,
      });
      await seedWorld(page, locale, 'idle');
      await page.getByTestId('view-board').click();
      await page.getByTestId('task-k1').hover();
      await page.waitForTimeout(700);
      await page.getByTestId('inspect-k1').click();
      await expect(page.getByTestId('inspector')).toBeVisible();
      await page.getByTestId('inspector-timeline-tab').click();
      await expect(page.getByTestId('timeline')).toBeVisible();
      await page.waitForTimeout(700);
      await page.screenshot({ path: shot('timeline') });
      await page.context().close();
    });
  }
});
