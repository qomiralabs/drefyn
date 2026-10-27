import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { OFF_ORIGIN, OFF_PORT, ON_ORIGIN, ON_PORT } from './e2e/fixtures.ts';

const chromium = devices['Desktop Chrome'];
const flags = (state: 'on' | 'off') =>
  fileURLToPath(new URL(`./e2e/flags/${state}.json`, import.meta.url));

// One production build, started twice: once with the release flag on and once off, so
// both flag states run in every e2e job. Build first with `pnpm --filter
// @drefyn/dashboard build`.
const server = (state: 'on' | 'off', port: number) => ({
  command: `pnpm exec next start --port ${port}`,
  // A static file, so readiness does not depend on the flag: with it off every route is 404.
  url: `http://127.0.0.1:${port}/robots.txt`,
  reuseExistingServer: false,
  timeout: 60_000,
  stdout: 'ignore' as const,
  stderr: 'pipe' as const,
  env: {
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    DREFYN_FLAGS_SOURCE: 'file',
    DREFYN_FLAGS_FILE: flags(state),
  },
});

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // Flaky tests are failures, so nothing retries.
  retries: 0,
  timeout: 30_000,
  forbidOnly: true,
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  updateSnapshots: 'none',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      threshold: 0,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  use: { baseURL: ON_ORIGIN },
  webServer: [server('on', ON_PORT), server('off', OFF_PORT)],
  projects: [
    {
      name: 'shell-chromium',
      testMatch: /(shell|states|keyboard|responsive|theme)\.spec\.ts$/,
      use: { ...chromium },
    },
    {
      name: 'shell-firefox',
      testMatch: /keyboard\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'shell-webkit',
      testMatch: /keyboard\.spec\.ts$/,
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'flag-off',
      testMatch: /flag-off\.spec\.ts$/,
      use: { ...chromium, baseURL: OFF_ORIGIN },
    },
    { name: 'axe', testMatch: /axe\.spec\.ts$/, use: { ...chromium } },
    {
      name: 'reduced-motion',
      testMatch: /reduced-motion\.spec\.ts$/,
      use: { ...chromium, reducedMotion: 'reduce' },
    },
    { name: 'bundle', testMatch: /bundle\.spec\.ts$/, use: { ...chromium } },
    { name: 'visual', testMatch: /visual\.spec\.ts$/, use: { ...chromium } },
  ],
});
