import { defineConfig, devices } from '@playwright/test';

// Tests share one seeded database, so they run in one worker, in order.
export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}-{platform}{ext}',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' },
  },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  projects: [
    // The Board baselines are of the state global setup seeded, so they run before anything
    // that changes it (the breaker reset, the process edit).
    { name: 'visual', testMatch: /\.visual\.spec\.ts$/ },
    { name: 'flows', testIgnore: /\.visual\.spec\.ts$/, dependencies: ['visual'] },
  ],
  use: {
    ...devices['Desktop Chrome'],
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
