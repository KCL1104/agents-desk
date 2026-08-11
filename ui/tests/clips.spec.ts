/**
 * One short recording per feature, not one long demo.
 *
 *   CLIP_DIR=../docs/media/.rec npx playwright test clips
 *
 * Skipped without CLIP_DIR, so the ordinary suite never pays for it.
 * Playwright records the webm; `scripts/readme-clips.mjs` turns each one
 * into a GIF with its *own* palette — a single global palette has to hold
 * terminal syntax colour, four status hues and diff red/green at once, and
 * that is exactly why the old README video drifted.
 *
 * Every clip is shot in the same staged world as the stills (`media.ts`),
 * with a real captured Claude Code TUI in any terminal that is on camera.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  LINES,
  feedLog,
  feedTui,
  mediaPage,
  repaintTerminals,
  seedWorld,
  type MediaLocale,
} from './media';

const OUT = process.env.CLIP_DIR;
test.skip(!OUT, 'set CLIP_DIR to record feature clips');

/** 1280×760 keeps a single pane over the TUI frame's measured ~88-column
    wrap threshold, and downscales to the README's width by a clean ratio. */
const SIZE = { width: 1280, height: 760 };

/** A beat after each action. A frame caught mid-repaint is where the old
    recording's broken TUI rows came from. */
async function beat(page: Page, ms = 650) {
  await page.waitForTimeout(ms);
}

/** A recording context in the staged world, its video landing under
    CLIP_DIR/<locale>/<name>/. */
async function clip(browser: Parameters<typeof mediaPage>[0], locale: MediaLocale, name: string) {
  const dir = join(OUT!, locale, name);
  mkdirSync(dir, { recursive: true });
  const page = await mediaPage(browser, locale, SIZE, 1, {
    drawer: 560,
    quietFirstRun: true,
    recordVideo: { dir, size: SIZE },
  });
  return page;
}

async function finish(page: Page) {
  await page.close();
  await page.context().close();
}

test.describe('feature clips', () => {
  for (const locale of ['en', 'zh-TW'] as const) {
    const L = () => LINES[locale];

    /* 1 · Triage. Something turns amber; one key puts you in front of it. */
    test(`triage (${locale})`, async ({ browser }) => {
      const page = await clip(browser, locale, 'triage');
      await seedWorld(page, locale, 'running');
      await page.getByTestId('view-board').click();
      await beat(page, 1500);
      // The desk goes on without you: a tool call lands, then a card blocks.
      await page.evaluate(() =>
        window.__mock.report('s101', 'running', { tool: 'Bash', detail: 'pytest tests/auth -x' }),
      );
      await beat(page, 900);
      await page.evaluate(() => window.__mock.report('s103', 'waiting_permission'));
      await beat(page, 1700);
      // ⌘E: the one key the triage loop is built around.
      await page.keyboard.press('ControlOrMeta+e');
      await beat(page, 700);
      await feedTui(page, 's103');
      await repaintTerminals(page);
      await beat(page, 1500);
      await finish(page);
    });

    /* 2 · Compose. A sentence becomes a card without leaving the keyboard. */
    test(`compose (${locale})`, async ({ browser }) => {
      const page = await clip(browser, locale, 'compose');
      await seedWorld(page, locale, 'idle');
      await page.getByTestId('view-board').click();
      await beat(page, 800);
      await page.keyboard.press('ControlOrMeta+k');
      await expect(page.getByTestId('palette')).toBeVisible();
      // Waiting sessions are already listed: an inbox first, a search second.
      await beat(page, 1100);
      await page.getByTestId('palette-input').pressSequentially(L().compose, { delay: 38 });
      await beat(page, 800);
      await page.getByTestId('pal-compose').click();
      await expect(page.getByTestId('task-prompt')).toBeVisible();
      await beat(page, 1400);
      await finish(page);
    });

    /* 3 · Attempt. The composed prompt is shown before it is sent, and the
       session it opens is a real terminal. */
    test(`attempt (${locale})`, async ({ browser }) => {
      const page = await clip(browser, locale, 'attempt');
      await seedWorld(page, locale, 'idle');
      // The staged world already holds three live sessions, which is the
      // default ceiling — without a fourth slot this card would queue, and
      // the clip would end on the board it was supposed to leave.
      await page.evaluate(() => {
        window.__mock.maxConcurrent = 4;
      });
      await page.getByTestId('view-board').click();
      await beat(page, 700);
      await page.locator('[data-testid="task-k6"] button.primary').click();
      await expect(page.getByTestId('attempt-prompt')).toBeVisible();
      // The whole prompt, editable, plus the permission mode for this one go.
      await beat(page, 1800);
      await page.getByTestId('attempt-mode').selectOption('accept_edits');
      await beat(page, 1200);
      await page.getByTestId('attempt-start').click();
      await beat(page, 700);
      // The attempt just made its own session; the newest one is it.
      const last = await page.evaluate(() => window.__mock.sessions.at(-1)?.id ?? 's1');
      await feedTui(page, last);
      await repaintTerminals(page);
      await beat(page, 1500);
      await finish(page);
    });

    /* 4 · Review. The diff sits beside the live terminal; a line takes a
       note; the batch goes back through the session's own input. */
    test(`review (${locale})`, async ({ browser }) => {
      const page = await clip(browser, locale, 'review');
      await seedWorld(page, locale, 'idle');
      await page.getByTestId('view-board').click();
      await beat(page, 600);
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('[data-testid="inspect-k1"]')?.click(),
      );
      await expect(page.getByTestId('diff-body')).toContainText('session.py');
      await feedLog(page, 's101');
      await repaintTerminals(page);
      await beat(page, 1300);
      await page.locator('.diff-line.del').first().click();
      await beat(page, 500);
      await page.getByTestId('review-note').pressSequentially(L().review, { delay: 28 });
      await beat(page, 600);
      await page.getByTestId('review-add').click();
      await beat(page, 900);
      await page.getByTestId('review-send').click();
      await beat(page, 1500);
      await finish(page);
    });

    /* 5 · Editable diff. The commonest ending to a review is a one-line fix,
       so the diff makes it — and then says so to the agent. */
    test(`edit (${locale})`, async ({ browser }) => {
      const page = await clip(browser, locale, 'edit');
      await seedWorld(page, locale, 'idle');
      await page.getByTestId('view-board').click();
      await beat(page, 500);
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('[data-testid="inspect-k1"]')?.click(),
      );
      await expect(page.getByTestId('diff-body')).toContainText('session.py');
      await feedLog(page, 's101');
      await repaintTerminals(page);
      await beat(page, 900);
      await page.getByTestId('diff-edit-0').click();
      await expect(page.getByTestId('file-editor')).toBeVisible();
      await beat(page, 1100);
      await page.locator('.file-editor .cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.press('Enter');
      await page.keyboard.type(L().edit, { delay: 24 });
      await beat(page, 600);
      await page.getByTestId('editor-save').click();
      await expect(page.getByTestId('editor-tell')).toBeVisible();
      await beat(page, 800);
      await page.getByTestId('editor-tell').click();
      await beat(page, 1400);
      await finish(page);
    });

    /* 6 · Knows. What the agent had already read before anyone typed —
       including the files that are not there. */
    test(`knows (${locale})`, async ({ browser }) => {
      const page = await clip(browser, locale, 'knows');
      await seedWorld(page, locale, 'idle');
      await page.getByTestId('view-board').click();
      await beat(page, 600);
      await page.evaluate(() =>
        document.querySelector<HTMLElement>('[data-testid="inspect-k1"]')?.click(),
      );
      await expect(page.getByTestId('inspector')).toBeVisible();
      await feedLog(page, 's101');
      await repaintTerminals(page);
      await beat(page, 900);
      await page.getByTestId('inspector-knows-tab').click();
      await expect(page.getByTestId('knows')).toBeVisible();
      await beat(page, 2200);
      await finish(page);
    });

    /* 7 · Settings. Found by what it is called on screen, not by which
       drawer it lives in. */
    test(`settings (${locale})`, async ({ browser }) => {
      const page = await clip(browser, locale, 'settings');
      await seedWorld(page, locale, 'idle');
      await beat(page, 700);
      await page.keyboard.press('ControlOrMeta+,');
      await expect(page.getByTestId('settings-body')).toBeVisible();
      await beat(page, 1000);
      await page.getByTestId('settings-search').pressSequentially(L().settingsSearch, { delay: 70 });
      await beat(page, 1100);
      await page.getByTestId('sec-sessions').click();
      await expect(page.getByTestId('checkpoints')).toBeVisible();
      await beat(page, 1800);
      await finish(page);
    });
  }
});
