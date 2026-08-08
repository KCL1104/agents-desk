import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';
import { MIN_PANE_H, MIN_PANE_W } from '../src/layout';

async function boot(page: Page) {
  await page.addInitScript(installMock);
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  // The arrangement lives on a tab, so nothing renders until one exists.
  await expect(page.locator('.tab')).toHaveCount(1);
}

async function newSession(page: Page, cwd: string) {
  await page.locator('.sidebar-head button.icon').click();
  await page.locator('.modal input.mono').first().fill(cwd);
  await page.locator('.modal button.primary').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

const report = (page: Page, id: string, status: string) =>
  page.evaluate(([i, st]) => window.__mock.report(i as string, st as string), [id, status] as const);

type Zone = 'center' | 'left' | 'right' | 'top' | 'bottom';

/**
 * Perform an HTML5 drag by dispatching the event sequence with one shared
 * DataTransfer, aimed at a particular zone of the target.
 *
 * Playwright's `dragTo` synthesises mouse movement, which does not reliably
 * carry a custom `dataTransfer` payload through to `drop`. Driving the events
 * directly exercises exactly the handlers the app registers — and lets the
 * pointer be placed precisely, which matters here because *where* in a pane
 * you let go is what decides between a swap and a split.
 */
async function drag(page: Page, from: string, to: string, zone: Zone = 'center') {
  await dragStart(page, from);
  await dropOnto(page, to, zone);
  await dragEnd(page);
}

type DragBag = { __dt?: DataTransfer; __src?: Element };

/**
 * Begin a drag and leave it in flight.
 *
 * Split from the drop so a test can wait in between. Targets that only exist
 * mid-drag — the layout's own edges — are rendered by a React state update
 * that lands after `dragstart` returns, so firing the whole sequence in one
 * synchronous block would look for them before they exist.
 */
async function dragStart(page: Page, from: string) {
  await page.evaluate((fromSel) => {
    const src = document.querySelector(fromSel);
    if (!src) throw new Error(`drag source missing: ${fromSel}`);
    const bag = window as unknown as DragBag;
    bag.__dt = new DataTransfer();
    bag.__src = src;
    src.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: bag.__dt }),
    );
  }, from);
}

async function dragEnd(page: Page) {
  await page.evaluate(() => {
    const bag = window as unknown as DragBag;
    bag.__src?.dispatchEvent(
      new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: bag.__dt }),
    );
  });
}

async function dropOnto(page: Page, to: string, zone: Zone = 'center') {
  await page.evaluate(
    ([toSel, where]) => {
      const bag = window as unknown as DragBag;
      const dataTransfer = bag.__dt;
      const dst = document.querySelector(toSel as string);
      if (!dst || !dataTransfer) throw new Error(`drop target missing: ${toSel}`);

      const r = dst.getBoundingClientRect();
      const points: Record<string, [number, number]> = {
        center: [r.x + r.width / 2, r.y + r.height / 2],
        left: [r.x + r.width * 0.05, r.y + r.height / 2],
        right: [r.x + r.width * 0.95, r.y + r.height / 2],
        top: [r.x + r.width / 2, r.y + r.height * 0.05],
        bottom: [r.x + r.width / 2, r.y + r.height * 0.95],
      };
      const [x, y] = points[where as string];

      const fire = (type: string) =>
        dst.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: x,
            clientY: y,
          }),
        );

      fire('dragenter');
      fire('dragover');
      fire('drop');
    },
    [to, zone] as const,
  );
}

/**
 * Which panes are on screen and where.
 *
 * Rectangles, not DOM order: panes stay in creation order in the document and
 * are *positioned* — by `order` in auto mode and by absolute coordinates in a
 * hand-built one — precisely so that rearranging never re-parents a terminal.
 * Anything asserting on document order is asserting on the wrong thing.
 */
async function panes(page: Page) {
  return page.locator('.pane:visible').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute('data-session-id'),
        focused: el.classList.contains('focused'),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }),
  );
}

/** Sessions in reading order: top to bottom, then left to right. */
async function order(page: Page) {
  const shown = await panes(page);
  return shown
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((p) => p.id);
}

/** How many distinct columns and rows the panes actually occupy. */
async function shape(page: Page) {
  const shown = await panes(page);
  return {
    cols: new Set(shown.map((p) => p.x)).size,
    rows: new Set(shown.map((p) => p.y)).size,
  };
}

/** Wait for the grid to settle on `n` visible panes. */
async function expectPanes(page: Page, n: number) {
  await expect.poll(async () => (await panes(page)).length, { timeout: 5000 }).toBe(n);
  return panes(page);
}

const pickCols = (page: Page, value: string) =>
  page.locator('[data-testid="col-picker"]').selectOption(value);

test.describe('automatic layout', () => {
  test('the number of columns follows the window, not a stored grid size', async ({ page }) => {
    await boot(page);
    for (const n of ['one', 'two', 'three', 'four']) {
      await newSession(page, `/Users/test/repo-${n}`);
    }
    await expectPanes(page, 4);

    // A laptop cannot hold four readable terminals side by side; a 27" screen
    // can. The same tab has to be right on both, which a stored "4x1" never is.
    await page.setViewportSize({ width: 900, height: 800 });
    await expect.poll(async () => (await shape(page)).cols).toBe(1);

    await page.setViewportSize({ width: 2400, height: 800 });
    await expect.poll(async () => (await shape(page)).cols).toBeGreaterThanOrEqual(3);
  });

  test('no pane is ever narrower than a TUI can use', async ({ page }) => {
    await boot(page);
    for (const n of ['one', 'two', 'three', 'four', 'five', 'six']) {
      await newSession(page, `/Users/test/repo-${n}`);
    }
    await expectPanes(page, 6);

    // The whole argument for deriving the column count: below about sixty
    // columns Claude Code's box drawing comes apart, so auto mode simply never
    // chooses a width that would do that.
    for (const p of await panes(page)) {
      expect(p.w).toBeGreaterThanOrEqual(MIN_PANE_W - 1);
    }
  });

  test('more panes than fit make the wall scroll rather than shrink', async ({ page }) => {
    await boot(page);
    await page.setViewportSize({ width: 1280, height: 700 });
    for (const n of ['one', 'two', 'three', 'four']) {
      await newSession(page, `/Users/test/repo-${n}`);
    }
    await expectPanes(page, 4);

    for (const p of await panes(page)) {
      expect(p.h).toBeGreaterThanOrEqual(MIN_PANE_H - 1);
    }
    const scrolls = await page
      .locator('.term-stack')
      .evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(scrolls).toBe(true);
  });

  test('an explicit column count overrides the width', async ({ page }) => {
    await boot(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const n of ['one', 'two', 'three']) {
      await newSession(page, `/Users/test/repo-${n}`);
    }
    await expectPanes(page, 3);

    // Narrower than is comfortable, but it was asked for explicitly.
    await pickCols(page, '3');
    await expect.poll(async () => (await shape(page)).cols).toBe(3);
  });

  test('the arrangement survives a reload', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await pickCols(page, '1');
    await page.reload();
    await expect(page.locator('[data-testid="col-picker"]')).toHaveValue('1');
  });
});

test.describe('rearranging by dragging', () => {
  test('two drags turn a row of four into a 2x2', async ({ page }) => {
    await boot(page);
    await page.setViewportSize({ width: 2400, height: 900 });
    for (const n of ['one', 'two', 'three', 'four']) {
      await newSession(page, `/Users/test/repo-${n}`);
    }
    await expectPanes(page, 4);
    await expect.poll(async () => shape(page)).toEqual({ cols: 4, rows: 1 });

    // Drop each of the last two onto the lower half of one of the first two.
    await drag(page, '[data-testid="pane-s3"] .pane-head', '[data-testid="pane-s1"]', 'bottom');
    await drag(page, '[data-testid="pane-s4"] .pane-head', '[data-testid="pane-s2"]', 'bottom');

    await expect.poll(async () => shape(page)).toEqual({ cols: 2, rows: 2 });
    await expect.poll(() => order(page)).toEqual(['s1', 's2', 's3', 's4']);

    // Equal shares, because the shape is new — old proportions carried into a
    // new arrangement read as a bug.
    const shown = await panes(page);
    expect(new Set(shown.map((p) => p.w)).size).toBe(1);
    expect(new Set(shown.map((p) => p.h)).size).toBe(1);
  });

  test('an edge splits the pane it lands on, not the row around it', async ({ page }) => {
    await boot(page);
    await page.setViewportSize({ width: 2400, height: 900 });
    for (const n of ['one', 'two', 'three']) {
      await newSession(page, `/Users/test/repo-${n}`);
    }
    await expectPanes(page, 3);
    const before = (await panes(page)).find((p) => p.id === 's2')!;

    await drag(page, '[data-testid="pane-s3"] .pane-head', '[data-testid="pane-s1"]', 'bottom');

    // s1 gave up its own half. Splitting the whole row instead would have
    // moved a pane the user never touched.
    await expect
      .poll(async () => (await panes(page)).find((p) => p.id === 's2')?.h)
      .toBe(before.h);
    const after = await panes(page);
    expect(after.find((p) => p.id === 's1')!.h).toBeLessThan(before.h);
    expect(after.find((p) => p.id === 's3')!.x).toBe(after.find((p) => p.id === 's1')!.x);
  });

  test('dropping on the middle of a pane swaps the two', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await expectPanes(page, 2);
    expect(await order(page)).toEqual(['s1', 's2']);

    await drag(page, '[data-testid="pane-s1"] .pane-head', '[data-testid="pane-s2"]', 'center');

    // Swapped, not one overwriting the other: rearranging must not cost you
    // the session you dropped onto.
    await expect.poll(() => order(page)).toEqual(['s2', 's1']);
  });

  test('a sidebar row can be dragged straight into a pane', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await expectPanes(page, 2);
    await page.locator('[data-testid="eject-s2"]').click();
    await expectPanes(page, 1);

    // Click and drag coexist: click is the fast path, drag says where.
    await drag(page, '[data-testid="session-s2"]', '[data-testid="pane-s1"]', 'right');
    await expect.poll(() => order(page)).toEqual(['s1', 's2']);
  });

  test('dropping on the layout edge spans that whole side', async ({ page }) => {
    await boot(page);
    await page.setViewportSize({ width: 2400, height: 900 });
    for (const n of ['one', 'two', 'three']) {
      await newSession(page, `/Users/test/repo-${n}`);
    }
    await expectPanes(page, 3);
    const width = (await panes(page)).find((p) => p.id === 's1')!.w;

    // Edge targets only exist while something is in flight, so they can never
    // sit in front of a terminal you are trying to click.
    await expect(page.locator('.edge-drop')).toHaveCount(0);
    await dragStart(page, '[data-testid="pane-s3"] .pane-head');
    await expect(page.locator('[data-testid="edge-bottom"]')).toBeVisible();
    await dropOnto(page, '[data-testid="edge-bottom"]');
    await dragEnd(page);

    // A pane-relative drop always splits the pane it landed on, so this is the
    // only gesture that can put something under *all* of them.
    await expect.poll(async () => (await panes(page)).find((p) => p.id === 's3')?.w).toBeGreaterThan(width * 1.9);
    await expect.poll(() => order(page)).toEqual(['s1', 's2', 's3']);
    await expect(page.locator('.edge-drop')).toHaveCount(0);
  });

  test('the picker admits the layout is hand-built, and can undo it', async ({ page }) => {
    await boot(page);
    await page.setViewportSize({ width: 2400, height: 900 });
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await expectPanes(page, 2);

    await drag(page, '[data-testid="pane-s2"] .pane-head', '[data-testid="pane-s1"]', 'bottom');
    await expect(page.locator('[data-testid="col-picker"]')).toHaveValue('manual');

    // Choosing a column count is the only undo a hand-built layout has.
    await pickCols(page, 'auto');
    await expect.poll(async () => (await shape(page)).rows).toBe(1);
  });

  test('ejecting a pane leaves the session running', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await drag(page, '[data-testid="pane-s2"] .pane-head', '[data-testid="pane-s1"]', 'bottom');
    await expectPanes(page, 2);

    await page.locator('[data-testid="eject-s2"]').click();
    await expect(page.locator('[data-testid="session-s2"]')).toBeVisible();

    // The split collapses rather than leaving s1 boxed into the half-height
    // its vanished neighbour left behind.
    await expectPanes(page, 1);
    await expect.poll(async () => (await panes(page))[0].id).toBe('s1');
  });
});

test.describe('resizing by dragging the boundary', () => {
  /** Split into two columns and hand back the vertical splitter. */
  async function twoUp(page: Page) {
    await boot(page);
    await page.setViewportSize({ width: 1400, height: 900 });
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await expectPanes(page, 2);
    await drag(page, '[data-testid="pane-s2"] .pane-head', '[data-testid="pane-s1"]', 'right');
    await expect(page.locator('.splitter.row')).toHaveCount(1);
    return page.locator('.splitter.row');
  }

  test('dragging the boundary moves it and only it', async ({ page }) => {
    const splitter = await twoUp(page);
    const before = await panes(page);
    const box = (await splitter.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect
      .poll(async () => (await panes(page)).find((p) => p.id === 's1')!.w)
      .toBeGreaterThan(before.find((p) => p.id === 's1')!.w + 150);
    const after = await panes(page);
    expect(after.find((p) => p.id === 's2')!.w).toBeLessThan(before.find((p) => p.id === 's2')!.w);
  });

  test('the proportion is kept, not just previewed', async ({ page }) => {
    const splitter = await twoUp(page);
    const box = (await splitter.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const wide = (await panes(page)).find((p) => p.id === 's1')!.w;

    // Written on release rather than on every frame: the intermediate values
    // are worth nothing and would be a database round trip each.
    await page.reload();
    await expectPanes(page, 2);
    await expect.poll(async () => (await panes(page)).find((p) => p.id === 's1')?.w).toBe(wide);
  });

  test('double-clicking the boundary restores equal shares', async ({ page }) => {
    const splitter = await twoUp(page);
    const box = (await splitter.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 200, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const p = await panes(page);
        return p[0].w === p[1].w;
      })
      .toBe(false);

    await page.locator('.splitter.row').dblclick();
    await expect
      .poll(async () => {
        const p = await panes(page);
        return Math.abs(p[0].w - p[1].w) <= 1;
      })
      .toBe(true);
  });

  test('the boundary answers arrow keys — role="separator" kept honest', async ({ page }) => {
    const splitter = await twoUp(page);
    const before = await panes(page);

    await splitter.focus();
    await page.keyboard.press('ArrowRight');

    // One keystroke's worth of pixels, committed immediately — and it
    // survives a reload the same way a drag does.
    await expect
      .poll(async () => (await panes(page)).find((p) => p.id === 's1')?.w)
      .toBeGreaterThan(before.find((p) => p.id === 's1')!.w + 10);
    const wide = (await panes(page)).find((p) => p.id === 's1')!.w;

    await page.reload();
    await expectPanes(page, 2);
    await expect.poll(async () => (await panes(page)).find((p) => p.id === 's1')?.w).toBe(wide);
  });
});

test.describe('focus and zoom', () => {
  test('exactly one pane holds focus, and clicking moves it', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    let shown = await expectPanes(page, 2);
    expect(shown.filter((p) => p.focused)).toHaveLength(1);

    // Keystrokes must land in the pane you clicked, so focus has to follow.
    await page.locator('.pane[data-session-id="s1"]').click({ position: { x: 20, y: 40 } });
    shown = await panes(page);
    expect(shown.filter((p) => p.focused)).toHaveLength(1);
    await expect(page.locator('.pane[data-session-id="s1"]')).toHaveClass(/focused/);
  });

  test('focus follows the session, not the position it was in', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await expectPanes(page, 2);
    await page.locator('.pane[data-session-id="s1"]').click({ position: { x: 20, y: 40 } });

    await drag(page, '[data-testid="pane-s1"] .pane-head', '[data-testid="pane-s2"]', 'center');

    // A position is not an identity. Keying focus on one meant a rearrangement
    // silently handed the keyboard to a different agent.
    await expect(page.locator('.topbar strong')).toHaveText('repo-one');
    await expect(page.locator('.pane[data-session-id="s1"]')).toHaveClass(/focused/);
  });

  test('zoom fills the layout with one pane and restores it', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await expectPanes(page, 2);

    // A dense wall is for surveying; zoom is how you work in one of them.
    await page.locator('[data-testid="zoom-s1"]').click();
    await expectPanes(page, 1);
    await expect(page.locator('[data-testid="pane-s1"]')).toHaveClass(/zoomed/);
    // The other pane is hidden, not unmounted: its PTY keeps running.
    await expect(page.locator('[data-testid="pane-s2"]')).toHaveCount(1);

    await page.locator('[data-testid="zoom-s1"]').click();
    await expectPanes(page, 2);
  });

  test('changing the columns drops the zoom rather than stranding it', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await newSession(page, '/Users/test/repo-two');
    await page.locator('[data-testid="zoom-s2"]').click();
    await expectPanes(page, 1);

    await pickCols(page, '1');
    await expect(page.locator('.pane.zoomed')).toHaveCount(0);
  });
});

test.describe('empty states', () => {
  test('an empty tab shows one prompt, not one stacked on another', async ({ page }) => {
    await boot(page);
    await expect(page.locator('.term-empty')).toHaveCount(1);

    // Two messages drawn over each other is a bug this app has already had.
    const overlaps = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.term-grid > *')]
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0);
      let n = 0;
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) n++;
        }
      }
      return n;
    });
    expect(overlaps).toBe(0);
  });

  test('the prompt goes once there is something to show', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await expectPanes(page, 1);
    await expect(page.locator('.term-empty')).toHaveCount(0);
  });
});

test.describe('tabs', () => {
  test('each tab keeps its own arrangement', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await pickCols(page, '1');
    await expectPanes(page, 1);

    await page.locator('.tab-add').click();
    await expect(page.locator('.tab')).toHaveCount(2);
    // A fresh tab starts on its own settings, not the previous tab's.
    await expect(page.locator('[data-testid="col-picker"]')).toHaveValue('auto');

    await page.locator('.tab').first().click();
    await expect(page.locator('[data-testid="col-picker"]')).toHaveValue('1');
  });

  test('a session moves between tabs rather than being shown in both', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await expectPanes(page, 1);

    await page.locator('.tab-add').click();
    await expect(page.locator('.tab')).toHaveCount(2);
    // Claiming it here must vacate it in the first tab: one PTY, one size.
    await page.locator('[data-testid="session-s1"]').click();
    await expect.poll(() => order(page)).toEqual(['s1']);

    await page.locator('.tab').first().click();
    await expectPanes(page, 0);
    await expect(page.locator('.term-empty')).toHaveCount(1);
  });

  test('losing a session to another tab closes the gap', async ({ page }) => {
    await boot(page);
    await page.setViewportSize({ width: 2400, height: 900 });
    for (const n of ['one', 'two', 'three']) {
      await newSession(page, `/Users/test/repo-${n}`);
    }
    await expectPanes(page, 3);

    await page.locator('.tab-add').click();
    await page.locator('[data-testid="session-s2"]').click();
    await page.locator('.tab').first().click();

    // The two that remain close ranks. A blank position left behind cannot be
    // told apart from one the user emptied on purpose, and every rule that
    // tried to tell them apart guessed wrong somewhere.
    await expect.poll(() => order(page)).toEqual(['s1', 's3']);
    await expect.poll(async () => (await shape(page)).cols).toBe(2);
  });

  test('a tab badges the sessions it is showing, so problems cannot hide', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await page.locator('.tab-add').click();
    await expect(page.locator('.tab')).toHaveCount(2);

    // Sitting in tab two while an agent in tab one is blocked is exactly the
    // failure this app exists to prevent.
    await report(page, 's1', 'waiting_permission');
    const badge = page.locator('.tab').first().locator('.tab-badge.waiting');
    await expect(badge).toHaveText('1');
    await expect(badge.locator('.icon-glyph')).toBeVisible();
  });

  test('closing a tab leaves its sessions running', async ({ page }) => {
    await boot(page);
    await newSession(page, '/Users/test/repo-one');
    await page.locator('.tab-add').click();
    await expect(page.locator('.tab')).toHaveCount(2);

    await page.locator('.tab').first().hover();
    await page.locator('.tab').first().locator('.tab-close').click();
    await expect(page.locator('.tab')).toHaveCount(1);

    // A tab is a view, not a container: the session survives it.
    await expect(page.locator('[data-testid="session-s1"]')).toBeVisible();
  });

  test('the last tab cannot be closed', async ({ page }) => {
    await boot(page);
    // With no tab there is nowhere to put a session, so the strip must never
    // empty out.
    await expect(page.locator('.tab')).toHaveCount(1);
    await expect(page.locator('.tab .tab-close')).toHaveCount(0);
  });
});

test.describe('naming tabs', () => {
  test('a new tab opens ready to be named', async ({ page }) => {
    await boot(page);
    await page.locator('.tab-add').click();

    // Naming is the point of having more than one tab, so it should not be a
    // double-click you have to discover.
    const input = page.locator('.tab-rename');
    await expect(input).toBeFocused();
    await input.fill('Auth 重構');
    await input.press('Enter');
    await expect(page.locator('.tab-name').last()).toHaveText('Auth 重構');
  });

  test('a tab can be renamed by double-clicking it', async ({ page }) => {
    await boot(page);
    await page.locator('.tab').first().dblclick();
    const input = page.locator('.tab-rename');
    await input.fill('Auth 重構');
    await input.press('Enter');
    await expect(page.locator('.tab-name').first()).toHaveText('Auth 重構');
  });

  test('escaping a rename keeps the old name', async ({ page }) => {
    await boot(page);
    await page.locator('.tab').first().dblclick();
    await page.locator('.tab-rename').fill('丟掉這個');
    await page.locator('.tab-rename').press('Escape');
    await expect(page.locator('.tab-name').first()).toHaveText('工作區');
  });
});
