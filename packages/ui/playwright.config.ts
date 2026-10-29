import { defineConfig, devices } from '@playwright/test';
import { ORIGIN } from './e2e/fixtures.ts';

const chromium = devices['Desktop Chrome'];

// Runs over the static Storybook build, served from disk by the fixture in e2e/. Build
// it first with storybook:build.
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
  // A missing baseline fails; baselines are only written by test:visual:update.
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
  use: { baseURL: ORIGIN },
  projects: [
    {
      name: 'keyboard-chromium',
      testMatch: /(\.keyboard|theme|network|paint|docs-ready)\.spec\.ts$/,
      use: { ...chromium },
    },
    {
      name: 'keyboard-firefox',
      testMatch: /(\.keyboard|theme|network|paint|docs-ready)\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'keyboard-webkit',
      testMatch: /(\.keyboard|theme|network|paint|docs-ready)\.spec\.ts$/,
      use: { ...devices['Desktop Safari'] },
    },
    // The network specs run here too, so the axe job itself proves the outside request guard.
    { name: 'axe', testMatch: /(axe|network)\.spec\.ts$/, use: { ...chromium } },
    // Chromium re-rasters only the part of a tile that changed, and how frames coalesce
    // decides that clip, so antialiased corners near a repaint (a focus move, an overlay)
    // came out a colour step apart between runs. Whole tile raster makes it repeatable.
    {
      name: 'visual',
      testMatch: /visual\.spec\.ts$/,
      use: { ...chromium, launchOptions: { args: ['--disable-partial-raster'] } },
    },
    {
      name: 'reduced-motion',
      testMatch: /reduced-motion\.spec\.ts$/,
      use: { ...chromium, reducedMotion: 'reduce' },
    },
  ],
});
