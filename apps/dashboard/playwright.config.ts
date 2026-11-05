import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import {
  HOP_ORIGIN,
  HOP_SERVER_PORT,
  OFF_ORIGIN,
  OFF_PORT,
  ON_ORIGIN,
  ON_PORT,
  OPEN_ORIGIN,
  OPEN_PORT,
} from './e2e/fixtures.ts';
import { FAKE_CLIENT_ENV, FAKE_ORIGIN, OAUTH_ORIGIN, OAUTH_PORT } from './e2e/oauth-fake.ts';
import { NO_LOOKUPS } from './e2e/oauth-lookups.ts';
import { MAYA, SIGNED_OUT, stateFile } from './e2e/people.ts';
import { serverEnv } from './e2e/stack-env.ts';

const chromium = devices['Desktop Chrome'];
const flags = (state: 'on' | 'off') =>
  fileURLToPath(new URL(`./e2e/flags/${state}.json`, import.meta.url));

// One production build, started twice through the wrapper: once with the release flag on and
// once off, so both flag states run in every e2e job. Each server gets its own origin, so
// its Origin and Host checks hold. Build first with `pnpm --filter @drefyn/dashboard build`,
// and seed with `seed:e2e` on a stack from scripts/selfhost.sh up.
const server = (
  state: 'on' | 'off',
  port: number,
  origin: string,
  hops: Record<string, string> = {},
  // A static file, so readiness does not depend on the flag: with it off every route is 404.
  ready: { url: string } | { port: number } = { url: `http://127.0.0.1:${port}/robots.txt` },
) => ({
  command: 'node server.ts',
  ...ready,
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
    ...hops,
  },
});

// Every spec on these servers shares one client address, so only the lockout specs on the
// third server meet the real limits.
const ROOMY = {
  DREFYN_AUTH_RATE_EMAIL_SEND: '1000/10m',
  DREFYN_AUTH_RATE_EMAIL_SEND_IP: '1000/10m',
  DREFYN_AUTH_RATE_EMAIL_SEND_DEVICE: '1000/1d',
  DREFYN_AUTH_RATE_EMAIL_SEND_ADDRESS_CEILING: '1000/1d',
  DREFYN_AUTH_RATE_CODE_VERIFY: '1000/1h',
  DREFYN_AUTH_RATE_PASSWORD_FAIL: '1000/15m',
  DREFYN_AUTH_RATE_PASSWORD_FAIL_IP: '1000/10m',
};

// Hops 1 with a non loopback origin, so the wrapper's start check stays on, and secure
// cookies, which that origin needs. Only the specs in the auth-hop project reach this one.
// The ceiling sits where four prefixes reach it, at three sends each, as in the auth tests.
const HOPS = {
  DREFYN_TRUSTED_PROXY_HOPS: '1',
  DREFYN_AUTH_COOKIE_SECURE: 'true',
  DREFYN_AUTH_RATE_EMAIL_SEND_ADDRESS_CEILING: '8/1d',
};
// Ready by port: this wrapper answers only the configured Host, and readiness sends none.
const hopServer = server('on', HOP_SERVER_PORT, HOP_ORIGIN, HOPS, { port: HOP_SERVER_PORT });

// Client ids put the provider buttons on the sign in page, so only these two servers have
// them and every other baseline stays as it is. The preload sends auth's provider calls to
// the fake without a setting in the build that could do the same in production.
const OAUTH = {
  ...FAKE_CLIENT_ENV,
  NODE_OPTIONS: '--import ./e2e/oauth-preload.ts',
};
// Every spec on this server starts a sign in from one client address.
const ROOMY_OAUTH = { ...ROOMY, DREFYN_AUTH_RATE_OAUTH_START: '1000/10m' };
// Chromium only, so these two projects stay on it.
const noLookups = { launchOptions: { args: [NO_LOOKUPS] } };

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
  webServer: [
    server('on', ON_PORT, ON_ORIGIN, ROOMY),
    server('off', OFF_PORT, OFF_ORIGIN, OAUTH),
    server('on', OPEN_PORT, OPEN_ORIGIN, { ...ROOMY, DREFYN_AUTH_SIGNUP: 'open' }),
    hopServer,
    server('on', OAUTH_PORT, OAUTH_ORIGIN, {
      ...ROOMY_OAUTH,
      ...OAUTH,
      DREFYN_AUTH_SIGNUP: 'open',
    }),
    {
      command: 'node e2e/oauth-fake-server.ts',
      url: `${FAKE_ORIGIN}/__health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore' as const,
      stderr: 'pipe' as const,
    },
  ],
  projects: [
    {
      name: 'shell-chromium',
      testMatch:
        /(shell|states|keyboard|responsive|theme|headers|loading|guard|sign-out|incident-mode)\.spec\.ts$/,
      use: { ...chromium },
    },
    {
      name: 'shell-firefox',
      testMatch: /(keyboard|headers|loading|sign-out)\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'shell-webkit',
      testMatch: /(keyboard|headers|loading|sign-out)\.spec\.ts$/,
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
      testMatch: /(reduced-motion|incident-mode)\.spec\.ts$/,
      use: { ...chromium, reducedMotion: 'reduce' },
    },
    {
      name: 'auth',
      testMatch:
        /(auth-(email|csrf|invite|cli-link|settings|oauth)|first-run|expiry-job)\.spec\.ts$/,
      // These count rows across the whole server, and read one inbox.
      workers: 1,
      use: { ...chromium, storageState: SIGNED_OUT, ...noLookups },
    },
    {
      name: 'auth-no-js',
      testMatch: /(no-script|first-run-no-script)\.spec\.ts$/,
      use: { ...chromium, storageState: SIGNED_OUT, javaScriptEnabled: false, ...noLookups },
    },
    {
      name: 'auth-hop',
      workers: 1,
      testMatch: /auth-(lockout|password-throttle)\.spec\.ts$/,
      use: {
        ...chromium,
        baseURL: HOP_ORIGIN,
        storageState: SIGNED_OUT,
      },
    },
    { name: 'bundle', testMatch: /bundle\.spec\.ts$/, use: { ...chromium } },
    {
      name: 'visual',
      testMatch: /visual\.spec\.ts$/,
      // Without it overlays differ by a few raster pixels between captures of one frame.
      use: { ...chromium, launchOptions: { args: ['--disable-partial-raster'] } },
    },
  ],
});
