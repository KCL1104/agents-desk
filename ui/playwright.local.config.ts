/**
 * Sandbox override, used only when passed explicitly:
 *
 *   npx playwright test --config playwright.local.config.ts
 *
 * Claude Code's web sandbox pre-installs one Chromium at
 * /opt/pw-browsers/chromium — a different build number than the pinned
 * @playwright/test downloads — so this points at it instead of fetching.
 * CI and dev machines keep using playwright.config.ts untouched.
 */
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  use: {
    ...base.use,
    launchOptions: { executablePath: '/opt/pw-browsers/chromium' },
  },
});
