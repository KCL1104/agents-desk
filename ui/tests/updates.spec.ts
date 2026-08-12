import { test, expect, type Page } from '@playwright/test';
import { installMock } from './mock-tauri';

/**
 * The update section, and the four things it must never do: offer a button
 * it cannot honour, apply anything nobody pressed, hide what a restart
 * costs, or interrupt the work to report a check it could not perform.
 */

/** Boot with the updater's answers rewritten. Applied as an init script so
 *  the values are in place before the panel's first paint — seeding after
 *  mount would race the effect that reads them. */
async function bootWith(page: Page, patch: Record<string, unknown>) {
  await page.addInitScript(installMock);
  await page.addInitScript((p) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown> };
    };
    const real = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === 'update_status') {
        return real(cmd, args).then((s) => ({ ...(s as object), ...p }));
      }
      if (cmd === 'update_check' && 'available' in p) {
        return Promise.resolve(p.available);
      }
      return real(cmd, args);
    };
  }, patch);
  await page.goto('/');
  await expect(page.locator('.tab')).toHaveCount(1);
}

async function openUpdates(page: Page) {
  await page.locator('.sidebar-foot').click();
  await page.getByTestId('sec-updates').click();
}

test.describe('updating in place', () => {
  /** The version the app is, said by the app. Until the updater needed it,
      this was the one fact about itself the interface never showed — the
      first thing anyone reporting a bug is asked for. */
  test('the diagnostics name this build', async ({ page }) => {
    await bootWith(page, {});
    await page.locator('.sidebar-foot').click();
    await page.getByTestId('sec-diagnostics').click();
    await expect(page.locator('.modal')).toContainText('0.6.0');
  });

  /** Nothing waiting is not a blank space: it is the sentence that says so. */
  test('being on the newest version says so', async ({ page }) => {
    await bootWith(page, {});
    await openUpdates(page);
    await expect(page.getByTestId('up-current')).toContainText('0.6.0');
    await expect(page.getByTestId('up-found')).toHaveCount(0);
  });

  /** A build with no key cannot verify a download, so it says that where
      the button would have been rather than offering one that can only
      fail — the same shape as every other refusal in this panel. */
  test('a build without an update key says so instead of offering a button', async ({ page }) => {
    await bootWith(page, { configured: false });
    await openUpdates(page);
    await expect(page.getByTestId('up-unconfigured')).toBeVisible();
    await expect(page.getByTestId('up-check')).toHaveCount(0);
    await expect(page.getByTestId('up-apply')).toHaveCount(0);
    // Not a dead end: the releases page is still a way to the new version.
    await expect(page.getByTestId('up-releases')).toBeVisible();
  });

  /** A deb or rpm belongs to the package manager that put it there. */
  test('a package-managed copy is sent to its own tooling', async ({ page }) => {
    await bootWith(page, { selfContained: false });
    await openUpdates(page);
    await expect(page.getByTestId('up-managed')).toBeVisible();
    await expect(page.getByTestId('up-apply')).toHaveCount(0);
    await expect(page.getByTestId('up-releases')).toBeVisible();
  });

  /** A newer release is offered, never applied. */
  test('a new version waits for a press', async ({ page }) => {
    await bootWith(page, {
      available: { version: '0.7.0', notes: 'Fixes the thing', date: null },
    });
    await openUpdates(page);

    // Nothing before the check: the app does not reach for the network to
    // paint a settings panel.
    await expect(page.getByTestId('up-found')).toHaveCount(0);

    await page.getByTestId('up-check').click();
    await expect(page.getByTestId('up-found')).toContainText('0.7.0');

    const applied = await page.evaluate(
      () =>
        (window as unknown as { __mock: { update: { applied: boolean[] } } }).__mock.update.applied,
    );
    expect(applied, 'showing an update is not applying it').toEqual([]);
  });

  /** Agents a tmux hands back are not a cost, and saying nothing about them
      would let somebody assume the worse of the two outcomes. */
  test('held agents are named as surviving the restart', async ({ page }) => {
    await bootWith(page, {
      held: 3,
      lost: 0,
      available: { version: '0.7.0', notes: null, date: null },
    });
    await openUpdates(page);
    await page.getByTestId('up-check').click();

    await expect(page.getByTestId('up-held')).toContainText('3');
    await expect(page.getByTestId('up-lost')).toHaveCount(0);
  });

  /** The count that changes what the button means. On a world with no
      holder — native Windows is the whole of that category — a restart ends
      the agents, and the button says so before it is pressed. */
  test('agents that would end are counted before the button is pressed', async ({ page }) => {
    await bootWith(page, {
      held: 1,
      lost: 2,
      available: { version: '0.7.0', notes: null, date: null },
    });
    await openUpdates(page);
    await page.getByTestId('up-check').click();

    await expect(page.getByTestId('up-lost')).toContainText('2');
    // The button stops being "download and restart" and becomes the thing
    // it actually does.
    await expect(page.getByTestId('up-apply')).toContainText('結束它們並更新');

    await page.getByTestId('up-apply').click();
    const applied = await page.evaluate(
      () =>
        (window as unknown as { __mock: { update: { applied: boolean[] } } }).__mock.update.applied,
    );
    expect(applied, 'the acknowledgement rides along, rather than being assumed').toEqual([true]);
  });

  /** With nothing to lose, the acknowledgement is not invented. */
  test('a quiet desk applies without claiming an acknowledgement', async ({ page }) => {
    await bootWith(page, {
      held: 0,
      lost: 0,
      available: { version: '0.7.0', notes: null, date: null },
    });
    await openUpdates(page);
    await page.getByTestId('up-check').click();
    await page.getByTestId('up-apply').click();

    const applied = await page.evaluate(
      () =>
        (window as unknown as { __mock: { update: { applied: boolean[] } } }).__mock.update.applied,
    );
    expect(applied).toEqual([false]);
  });

  /** Offline, rate-limited, GitHub down: none of these are things a person
      can act on, and a courtesy that interrupts the work to report that it
      could not be performed has become a cost. */
  test('a failed check says nothing at all', async ({ page }) => {
    await page.addInitScript(installMock);
    await page.addInitScript(() => {
      const w = window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (c: string, a?: Record<string, unknown>) => Promise<unknown>;
        };
      };
      const real = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = (cmd, args) =>
        cmd === 'update_check'
          ? Promise.reject(new Error('error sending request: dns error'))
          : real(cmd, args);
    });
    await page.goto('/');
    await expect(page.locator('.tab')).toHaveCount(1);
    await openUpdates(page);

    await page.getByTestId('up-check').click();

    // Back to the resting state, with no error anywhere on screen.
    await expect(page.getByTestId('up-check')).toBeEnabled();
    await expect(page.getByTestId('up-error')).toHaveCount(0);
    await expect(page.locator('.modal')).not.toContainText('dns');
  });

  /** A failed *apply* is the opposite case: somebody pressed a button and is
      waiting for it, so the reason is theirs to see. */
  test('a failed apply is reported, because somebody is waiting on it', async ({ page }) => {
    await bootWith(page, {
      available: { version: '0.7.0', notes: null, date: null },
    });
    await page.evaluate(() => {
      (
        window as unknown as { __mock: { update: { applyError: string | null } } }
      ).__mock.update.applyError = 'the copy that makes this upgrade reversible could not be taken';
    });
    await openUpdates(page);
    await page.getByTestId('up-check').click();
    await page.getByTestId('up-apply').click();

    await expect(page.getByTestId('up-error')).toContainText('reversible');
  });

  /** The off switch, and the sentence that makes "no telemetry" checkable
      rather than asserted. */
  test('checking can be turned off, and the panel says what it sends', async ({ page }) => {
    await bootWith(page, {});
    await openUpdates(page);

    await expect(page.locator('.modal')).toContainText('不會送出這台機器的任何資料');

    const toggle = page.getByTestId('up-toggle');
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    const enabled = await page.evaluate(
      () => (window as unknown as { __mock: { update: { enabled: boolean } } }).__mock.update.enabled,
    );
    expect(enabled).toBe(false);
  });

  /** The news reaches the corner, not the board. A panel landing over a card
      that just turned amber is the worst thing this app could do with it. */
  test('a waiting version shows as a dot in the corner, and nothing else', async ({ page }) => {
    await bootWith(page, {
      available: { version: '0.7.0', notes: null, date: null },
    });
    await expect(page.getByTestId('update-dot')).toBeVisible();
    // No modal, no toast, no banner over the work.
    await expect(page.locator('.modal')).toHaveCount(0);
    await expect(page.getByTestId('update-dot')).toHaveAttribute('aria-label', /0\.7\.0/);
  });

  /** Nothing waiting is no dot — not a grey one, not an empty slot. */
  test('the corner stays empty when there is nothing to say', async ({ page }) => {
    await bootWith(page, {});
    await page.locator('.sidebar-foot').click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.getByTestId('update-dot')).toHaveCount(0);
  });

  /** The switch is not merely cosmetic: off means the request is not made. */
  test('with checking off, no version request is made at all', async ({ page }) => {
    await bootWith(page, {
      enabled: false,
      available: { version: '0.7.0', notes: null, date: null },
    });
    await expect(page.locator('.sidebar-foot')).toBeVisible();
    await expect(page.getByTestId('update-dot')).toHaveCount(0);

    const asked = await page.evaluate(
      () =>
        (window as unknown as { __mock: { calls: Array<{ cmd: string }> } }).__mock.calls.filter(
          (c) => c.cmd === 'update_check',
        ).length,
    );
    expect(asked, 'the off switch stops the request, not just the dot').toBe(0);
  });

  /** Once a day, not once a launch. */
  test('a check that is not due is not repeated', async ({ page }) => {
    await bootWith(page, {
      due: false,
      available: { version: '0.7.0', notes: null, date: null },
    });
    await expect(page.locator('.sidebar-foot')).toBeVisible();
    await expect(page.getByTestId('update-dot')).toHaveCount(0);

    const asked = await page.evaluate(
      () =>
        (window as unknown as { __mock: { calls: Array<{ cmd: string }> } }).__mock.calls.filter(
          (c) => c.cmd === 'update_check',
        ).length,
    );
    expect(asked).toBe(0);
  });

  /** Searchable by what it is called on screen, like every other setting. */
  test('the section is reachable from the settings search', async ({ page }) => {
    await bootWith(page, {});
    await page.locator('.sidebar-foot').click();
    await page.getByTestId('settings-search').fill('更新');
    await expect(page.getByTestId('sec-updates')).toBeVisible();
  });
});
