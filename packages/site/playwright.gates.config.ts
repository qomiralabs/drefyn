import { defineConfig, devices } from '@playwright/test';
import { BREACH_ENV, ORIGIN } from './gates/pages.ts';

const engines = {
  chromium: devices['Desktop Chrome'],
  firefox: devices['Desktop Firefox'],
  webkit: devices['Desktop Safari'],
} as const;

const PER_ENGINE = /(no-script|axe|keyboard|reduced-motion)\.spec\.ts$/;

// Built pages served over HTTP by gates/server.ts, the way a static host serves them, so
// Lighthouse and every engine load real responses.
export default defineConfig({
  testDir: './gates',
  outputDir: './test-results/gates',
  // Flaky tests are failures, so nothing retries.
  retries: 0,
  timeout: 30_000,
  forbidOnly: true,
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  // A missing baseline fails; baselines are only written by test:gates:update.
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
  webServer: {
    command: 'node gates/server.ts',
    url: `${ORIGIN}/__ready`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { [BREACH_ENV]: process.env[BREACH_ENV] ?? '' },
  },
  projects: [
    // One at a time, because each of these times or scores a page and a neighbour is noise.
    { name: 'budgets', workers: 1, testMatch: /budgets\.spec\.ts$/, use: { ...engines.chromium } },
    ...(['chromium', 'firefox', 'webkit'] as const).flatMap((engine) => [
      { name: engine, testMatch: PER_ENGINE, use: { ...engines[engine] } },
      {
        name: `visual-${engine}`,
        testMatch: /visual\.spec\.ts$/,
        use: {
          ...engines[engine],
          // Whole tile raster, so antialiased edges near a repaint match between runs.
          ...(engine === 'chromium'
            ? { launchOptions: { args: ['--disable-partial-raster'] } }
            : {}),
        },
      },
    ]),
  ],
});
