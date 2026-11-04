import { defineConfig, devices } from '@playwright/test';

// Runs over the static files from `pnpm --filter @drefyn/email preview`.
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // Flaky tests are failures, so nothing retries.
  retries: 0,
  timeout: 30_000,
  forbidOnly: true,
  fullyParallel: true,
  workers: 4,
  reporter: 'line',
  use: { ...devices['Desktop Chrome'] },
});
