import { test, expect, type Page, type Browser } from '@playwright/test';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installMock } from './mock-tauri';

/**
 * README media, staged on the real UI.
 *
 * Not part of the suite: these run only under SHOTS=1 and write PNGs (and
 * one recording) into docs/media/. The frames are the actual React tree,
 * the actual stylesheet, and xterm rendering a real captured Claude Code
 * TUI — only the backend is the same mock every test trusts. Staged data,
 * true pixels.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MEDIA = join(here, '..', '..', 'docs', 'media');

const tui = JSON.parse(
  readFileSync(join(here, 'fixtures/claude-tui.json'), 'utf8'),
) as { chunks: string[] };

/** A second terminal's worth of honest-looking output: a vitest run with
    ANSI color, so the wall does not show the same frame twice. */
const TEST_LOG = [
  '\x1b[36m$ npx vitest run --reporter=verbose\x1b[0m',
  '',
  '\x1b[32m✓\x1b[0m src/api/limiter.test.ts \x1b[90m(9 tests)\x1b[0m \x1b[33m412ms\x1b[0m',
  '\x1b[32m✓\x1b[0m src/api/session.test.ts \x1b[90m(14 tests)\x1b[0m \x1b[33m230ms\x1b[0m',
  '\x1b[32m✓\x1b[0m src/auth/tokens.test.ts \x1b[90m(6 tests)\x1b[0m \x1b[33m88ms\x1b[0m',
  '',
  '\x1b[1mTest Files\x1b[0m  \x1b[32m3 passed\x1b[0m \x1b[90m(3)\x1b[0m',
  '\x1b[1m     Tests\x1b[0m  \x1b[32m29 passed\x1b[0m \x1b[90m(29)\x1b[0m',
  '\x1b[90m  Duration\x1b[0m  1.42s',
  '',
].join('\r\n');

const DIFF = [
  'diff --git a/src/auth/session.py b/src/auth/session.py',
  'index 3f1c2aa..9d04b71 100644',
  '--- a/src/auth/session.py',
  '+++ b/src/auth/session.py',
  '@@ -12,9 +12,11 @@ def login(request):',
  '     user = authenticate(request)',
  '     if user is None:',
  '-        return redirect("/login")  # loops when the session cookie is stale',
  '+        clear_session_cookie(request)',
  '+        return redirect("/login?expired=1")',
  '     session = Session.create(user)',
  '-    session.ttl = 3600',
  '+    # TTL follows the "remember me" checkbox, not a constant',
  '+    session.ttl = 30 * 86400 if request.POST.get("remember") else 3600',
  '     return respond(request, session)',
  'diff --git a/src/auth/cookies.py b/src/auth/cookies.py',
  'new file mode 100644',
  'index 0000000..b7ad433',
  '--- /dev/null',
  '+++ b/src/auth/cookies.py',
  '@@ -0,0 +1,7 @@',
  '+"""Session-cookie helpers shared by login and logout."""',
  '+',
  '+def clear_session_cookie(request):',
  '+    """Expire the cookie the stale-redirect loop was feeding on."""',
  '+    request.cookies.pop("sid", None)',
  '+    request.response.delete_cookie("sid")',
  '+',
].join('\n');

const SESSION_BASE = [
  'def login(request):',
  '    user = authenticate(request)',
  '    if user is None:',
  '        return redirect("/login")  # loops when the session cookie is stale',
  '    session = Session.create(user)',
  '    session.ttl = 3600',
  '    return respond(request, session)',
  '',
].join('\n');

const SESSION_WORK = [
  'def login(request):',
  '    user = authenticate(request)',
  '    if user is None:',
  '        clear_session_cookie(request)',
  '        return redirect("/login?expired=1")',
  '    session = Session.create(user)',
  '    # TTL follows the "remember me" checkbox, not a constant',
  '    session.ttl = 30 * 86400 if request.POST.get("remember") else 3600',
  '    return respond(request, session)',
  '',
].join('\n');

/** Card titles, per locale — the one thing screenshots must localize. */
const TITLES: Record<string, string[]> = {
  en: [
    'Fix the login redirect loop',
    'Rate-limit the public API',
    'Migrate settings to SQLite',
    'Dark theme for the editor',
    'Spike: import from Linear',
    'Polish the onboarding empty state',
    'Workspace',
  ],
  'zh-TW': [
    '修好登入轉圈圈',
    '公開 API 加上限流',
    '設定搬進 SQLite',
    '編輯器深色主題',
    '試作：從 Linear 匯入',
    '打磨初次上手的空狀態',
    '工作區',
  ],
};

/** Build the whole desk in one evaluate: five cards across the lifecycle,
    their sessions, stats, checkpoints, diffs — the world the README shows. */
async function seedWorld(page: Page, locale: string, k1Status: string) {
  await page.evaluate(
    ({ titles, diff, base, work, k1Status }) => {
      const m = window.__mock;
      const now = Date.now();
      const mkSession = (
        id: string,
        cwd: string,
        title: string,
        status: string,
        attemptId: string | null,
        extra: Record<string, unknown> = {},
      ) => ({
        id,
        cwd,
        title,
        agent: 'claude',
        status,
        created_at: now - 3600e3,
        last_active_at: now - 45e3,
        live: true,
        reports_status: true,
        preview_port: null,
        activity: null,
        activity_since: now - 90e3,
        completed: false,
        attempt_id: attemptId,
        usage: null,
        ...extra,
      });
      const mkAttempt = (
        id: string,
        taskId: string,
        sessionId: string | null,
        extra: Record<string, unknown> = {},
      ) => ({
        id,
        task_id: taskId,
        seq: 1,
        agent: 'claude',
        worktree_path: `/Users/dev/worktrees/${taskId}`,
        branch: `agentdesk/${taskId}-1`,
        base_sha: 'abcd1234deadbeef',
        mode: 'normal',
        outcome: null,
        frozen_diff: null,
        created_at: now - 3000e3,
        parked_at: null,
        session_id: sessionId,
        ...extra,
      });
      const mkTask = (
        id: string,
        title: string,
        lifecycle: string,
        position: number,
        attempts: unknown[],
      ) => ({
        id,
        title,
        prompt: title,
        repo_path: '/Users/dev/webapp',
        base_branch: 'main',
        lifecycle,
        position,
        created_at: now - 86400e3,
        attempts,
        queued_at: null,
      });

      // k1 — the star: the redirect-loop fix, settled or mid-turn per scene.
      const s1 = mkSession('s101', '/Users/dev/worktrees/k1', `${titles[0]} #1`, k1Status, 'k1-a1', {
        activity:
          k1Status === 'running' ? { tool: 'Bash', detail: 'pytest tests/auth -x' } : null,
        usage: {
          input: 48_213,
          output: 612_400,
          cache_read: 96_420_113,
          cache_write: 5_204_887,
          context: 74_310,
        },
      });
      // k2 — blocked on a human: the breathing card.
      const s2 = mkSession('s102', '/Users/dev/worktrees/k2', `${titles[1]} #1`, 'waiting_permission', 'k2-a1', {
        activity: { tool: 'Edit', detail: 'src/api/limiter.ts' },
      });
      // k3 — reviewing, agent idle.
      const s3 = mkSession('s103', '/Users/dev/worktrees/k3', `${titles[2]} #1`, 'idle', 'k3-a1');

      m.sessions.push(s1, s2, s3);
      m.tasks.push(
        mkTask('k1', titles[0], 'running', 0, [mkAttempt('k1-a1', 'k1', 's101')]),
        mkTask('k2', titles[1], 'running', 1, [
          mkAttempt('k2-a1', 'k2', 's102', { mode: 'accept_edits' }),
        ]),
        mkTask('k3', titles[2], 'review', 0, [mkAttempt('k3-a1', 'k3', 's103')]),
        mkTask('k4', titles[3], 'done', 0, [
          mkAttempt('k4-a1', 'k4', null, {
            outcome: 'merged',
            frozen_diff: 'diff --git a/theme.css b/theme.css\n+dark\n',
          }),
        ]),
        mkTask('k5', titles[4], 'running', 2, [
          mkAttempt('k5-a1', 'k5', null, { parked_at: now - 7200e3 }),
        ]),
        mkTask('k6', titles[5], 'backlog', 0, []),
      );

      m.stats.set('k1-a1', { files: 2, adds: 11, dels: 2, ahead: 2, behind: 0, dirty: true });
      m.stats.set('k2-a1', { files: 5, adds: 342, dels: 57, ahead: 0, behind: 3, dirty: false });
      m.stats.set('k3-a1', { files: 1, adds: 22, dels: 4, ahead: 1, behind: 0, dirty: false });
      m.diffs.set('k1-a1', diff);
      m.files.set('k1-a1:src/auth/session.py', { base, work });
      m.checkpoints.set('k1-a1', [
        { n: 1, sha: 'cafe100', at: Math.floor(now / 1000) - 2400 },
        { n: 2, sha: 'cafe200', at: Math.floor(now / 1000) - 600 },
      ]);
      m.record('k1-a1', 'prompt', null, titles[0]);
      m.record('k1-a1', 'tool', 'Bash', 'pytest tests/auth -x');

      // The default tab name ships in zh; the en frames should not wear it.
      m.tabs[0].name = titles[6];
      m.emit('tabs:changed', m.tabs);

      m.pushSessions();
      m.pushTasks();
    },
    { titles: TITLES[locale], diff: DIFF, base: SESSION_BASE, work: SESSION_WORK, k1Status },
  );
}

/** Pin the locale (and the drawer width) before the app boots. */
function localeScript(locale: string, drawer = 600) {
  return `
    localStorage.setItem('agentdesk.locale', ${JSON.stringify(locale)});
    localStorage.setItem('agentdesk.inspectorWidth', '${drawer}');
  `;
}

/** The board, columns only. The hover peek is skipped on purpose: it
    clamps to 520px (~65 cols), under the TUI frame's measured wrap
    threshold (~88 cols) — a shredded terminal would sell dishonesty. */
async function stageBoard(page: Page) {
  await page.getByTestId('view-board').click();
  await page.waitForTimeout(900);
}

/** The drawer on k1: diff, one pending comment, the in-place editor open. */
async function stageInspector(page: Page, locale: string) {
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
  await page.evaluate((chunks) => {
    window.__mock.feed('s101', chunks[0], 1);
    window.__mock.feed('s101', chunks[1], 2);
  }, tui.chunks);
  // One comment pending on the stale-redirect line.
  await page.locator('.diff-line.del').first().click();
  await page
    .getByTestId('review-note')
    .fill(
      locale === 'en'
        ? 'Clear the cookie before redirecting, or the loop survives.'
        : '先清掉 cookie 再轉址，不然還是會轉圈圈。',
    );
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

    test(`board hero (${locale})`, async ({ browser }) => {
      mkdirSync(MEDIA, { recursive: true });
      const page = await shotPage(browser, locale, { width: 1280, height: 800 });
      await seedWorld(page, locale, 'running');
      await stageBoard(page);
      await page.screenshot({ path: join(MEDIA, `board.${tag}.png`) });
      await page.context().close();
    });

    test(`inspector with the editable diff (${locale})`, async ({ browser }) => {
      // Wide enough that the pane beside a 600px drawer stays over the
      // frame's ~88-col wrap threshold.
      const page = await shotPage(browser, locale, { width: 1760, height: 780 }, 1);
      await seedWorld(page, locale, 'idle');
      await stageInspector(page, locale);
      await page.screenshot({ path: join(MEDIA, `inspector.${tag}.png`) });
      await page.context().close();
    });

    test(`terminal wall (${locale})`, async ({ browser }) => {
      // Two panes at ~88 cols each — the measured no-wrap floor.
      const page = await shotPage(browser, locale, { width: 1500, height: 640 }, 1);
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
      await page.evaluate(
        ({ chunks, log }) => {
          window.__mock.feed('s1', chunks[0], 1);
          window.__mock.feed('s1', chunks[1], 2);
          window.__mock.feed('s2', log, 1);
        },
        // Encoded here, not with btoa in the page: the log carries ✓ and
        // box glyphs, which are beyond btoa's Latin-1 and exactly the
        // UTF-8 bytes xterm's decoder is built to eat.
        { chunks: tui.chunks, log: Buffer.from(TEST_LOG).toString('base64') },
      );
      await page.waitForTimeout(900);
      await repaintTerminals(page);
      await page.screenshot({ path: join(MEDIA, `wall.${tag}.png`) });
      await page.context().close();
    });
  }

  test('demo recording (en)', async ({ browser }) => {
    mkdirSync(join(MEDIA, '.rec'), { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 820 },
      deviceScaleFactor: 1,
      recordVideo: { dir: join(MEDIA, '.rec'), size: { width: 1600, height: 820 } },
    });
    // 520px drawer keeps the pane beside it over the no-wrap floor.
    await context.addInitScript(localeScript('en', 520));
    await context.addInitScript(installMock);
    const page = await context.newPage();
    await page.goto('http://localhost:5174/');
    await expect(page.locator('.tab')).toHaveCount(1);
    await seedWorld(page, 'en', 'idle');

    // The loop the product exists for: see it, review it, fix the last
    // line yourself, tell the agent, merge.
    await page.getByTestId('view-board').click();
    await page.waitForTimeout(1600);

    // Programmatic click, no mouse travel: hovering the card slides the
    // peek in and shifts every column mid-aim — and at this width the
    // peek would shred the TUI frame on camera besides.
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('[data-testid="inspect-k1"]')?.click(),
    );
    await expect(page.getByTestId('diff-body')).toContainText('session.py');
    await page.evaluate((chunks) => {
      window.__mock.feed('s101', chunks[0], 1);
      window.__mock.feed('s101', chunks[1], 2);
    }, tui.chunks);
    await page.waitForTimeout(1600);

    await page.locator('.diff-line.del').first().click();
    await page.waitForTimeout(400);
    await page
      .getByTestId('review-note')
      .pressSequentially('Clear the cookie before redirecting.', { delay: 28 });
    await page.getByTestId('review-add').click();
    await page.waitForTimeout(900);

    await page.getByTestId('diff-edit-0').click();
    await expect(page.getByTestId('file-editor')).toBeVisible();
    await page.waitForTimeout(1100);
    await page.locator('.file-editor .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('# reviewed by hand, right here in the diff', { delay: 24 });
    await page.waitForTimeout(500);
    await page.getByTestId('editor-save').click();
    await expect(page.getByTestId('editor-tell')).toBeVisible();
    await page.waitForTimeout(700);
    await page.getByTestId('editor-tell').click();
    await page.waitForTimeout(600);
    await page.getByTestId('editor-close').click();
    await page.waitForTimeout(700);

    await page.getByTestId('merge-attempt').click();
    await page.waitForTimeout(1300);
    await page.getByTestId('confirm-merge').click();
    await page.waitForTimeout(2000);

    await page.close();
    const video = page.video();
    if (video) {
      const src = await video.path();
      await context.close();
      copyFileSync(src, join(MEDIA, '.rec', 'demo.webm'));
    } else {
      await context.close();
    }
  });
});

/** Headless screenshots race the GPU: a keyed re-sort reparents the
    xterm canvas and can shed its WebGL context between paint and capture.
    A forced full refresh right before the shot settles what the pixels
    say to what the buffer holds. */
async function repaintTerminals(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll<HTMLElement & { __term?: any }>('.term-host').forEach((el) => {
      const t = el.__term;
      if (t) t.refresh(0, t.rows - 1);
    });
  });
  await page.waitForTimeout(600);
}

/** A fresh @2x context with the mock and locale pinned. */
async function shotPage(
  browser: Browser,
  locale: string,
  viewport: { width: number; height: number },
  // Scenes with live terminals shoot at 1x: headless WebGL paints
  // nothing onto @2x canvases here, and a blank terminal is worse than
  // a 1x one. DOM-only scenes keep the crisper 2x.
  dpr = 2,
): Promise<Page> {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: dpr,
  });
  await context.addInitScript(localeScript(locale));
  await context.addInitScript(installMock);
  const page = await context.newPage();
  await page.goto('http://localhost:5174/');
  await expect(page.locator('.tab')).toHaveCount(1);
  return page;
}
