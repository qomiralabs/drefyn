import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { OFF_ORIGIN, OFF_PORT, ON_ORIGIN, ON_PORT } from './e2e/fixtures.ts';
import { MAYA, SIGNED_OUT, stateFile } from './e2e/people.ts';
import { serverEnv } from './e2e/stack-env.ts';

const chromium = devices['Desktop Chrome'];
const flags = (state: 'on' | 'off') =>
  fileURLToPath(new URL(`./e2e/flags/${state}.json`, import.meta.url));

// One production build, started twice through the wrapper: once with the release flag on and
// once off, so both flag states run in every e2e job. Each server gets its own origin, so
// its Origin and Host checks hold. Build first with `pnpm --filter @drefyn/dashboard build`,
// and seed with `seed:e2e` on a stack from scripts/selfhost.sh up.
const server = (state: 'on' | 'off', port: number, origin: string) => ({
  command: 'node server.ts',
  // A static file, so readiness does not depend on the flag: with it off every route is 404.
  url: `${origin}/robots.txt`,
  reuseExistingServer: false,
  timeout: 60_000,
  stdout: 'ignore' as const,
  stderr: 'pipe' as const,
  env: {
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    // Named here because a container sets HOSTNAME to its own id.
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    DREFYN_FLAGS_SOURCE: 'file',
    DREFYN_FLAGS_FILE: flags(state),
    ...serverEnv(origin),
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
  // Every spec is the seeded owner unless it says otherwise, so a page opens as it would for
  // a person, through the real guard.
  use: { baseURL: ON_ORIGIN, storageState: stateFile(MAYA) },
  webServer: [server('on', ON_PORT, ON_ORIGIN), server('off', OFF_PORT, OFF_ORIGIN)],
  projects: [
    {
      name: 'shell-chromium',
      testMatch: /(shell|states|keyboard|responsive|theme|headers|loading|guard)\.spec\.ts$/,
      use: { ...chromium },
    },
    {
      name: 'shell-firefox',
      testMatch: /(keyboard|headers|loading)\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'shell-webkit',
      testMatch: /(keyboard|headers|loading)\.spec\.ts$/,
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'flag-off',
      testMatch: /(flag-off|headers)\.spec\.ts$/,
      use: { ...chromium, baseURL: OFF_ORIGIN, storageState: SIGNED_OUT },
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
