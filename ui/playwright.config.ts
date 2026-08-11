import { defineConfig, devices } from '@playwright/test';

/**
 * Every test builds its own world.
 *
 * There is no shared fixture to collide over: each one gets a fresh browser
 * context, and `installMock` puts a fresh backend in that context's own page.
 * The only shared thing is the vite server below, which serves static files
 * and holds no state. So the serial default was buying nothing, and it cost
 * the whole suite: on four cores 1 worker takes 6m57s, `fullyParallel` with
 * 3 takes 4m09s, for the same 294 passing.
 *
 * Three rather than four: the vite server needs a core, and a machine pinned
 * flat is where the visual baselines start disagreeing about anti-aliasing.
 * CI runners are smaller and shared, so they take two.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
