import { defineConfig, devices } from '@playwright/test';

/** End-to-end tests: mock provider + AnyCast server + built web app, Chromium only. Run with `pnpm e2e` at the repo root. */
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
  outputDir: 'e2e-results',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [{ name: 'chromium' }],
});
