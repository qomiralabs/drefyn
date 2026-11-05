import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { themeStorageKey } from '@drefyn/ui';
import { chromium, expect, type BrowserContext } from '@playwright/test';
import lighthouse from 'lighthouse';
import { DESKTOP, ON_ORIGIN, THEMES, type Theme } from './fixtures.ts';
import { SHELL_ROUTES } from './lighthouse-routes.ts';
import { MAYA, stateFile } from './people.ts';
import { test } from './test.ts';

const MINIMUM_SCORE = 90;
const CATEGORIES = ['accessibility', 'best-practices'] as const;
const DEBUG_PORT = 9333;
const SETTLE_MS = 1000;
const REPORTS = fileURLToPath(new URL('../test-results/lighthouse/', import.meta.url));
const PATHS = Object.values(SHELL_ROUTES).flat();

// In order, one theme at a time, and a low score leaves the routes after it still scored.
test.describe.configure({ mode: 'default' });

const fileName = (path: string, theme: Theme) =>
  `${path.replaceAll('/', '-').replace(/^-/, '')}-${theme}.json`;

for (const theme of THEMES) {
  test.describe(`in ${theme}`, () => {
    let context: BrowserContext;
    let profile: string;

    // A persistent profile, because Lighthouse opens its own tab and only the default
    // context's cookies and storage reach it.
    test.beforeAll(async ({ baseURL }) => {
      profile = mkdtempSync(join(tmpdir(), 'lighthouse-'));
      context = await chromium.launchPersistentContext(profile, {
        args: [`--remote-debugging-port=${String(DEBUG_PORT)}`],
        viewport: DESKTOP,
      });
      const { cookies } = JSON.parse(readFileSync(stateFile(MAYA), 'utf8')) as {
        cookies: Parameters<BrowserContext['addCookies']>[0];
      };
      await context.addCookies(cookies);
      const page = await context.newPage();
      await page.goto(new URL('/robots.txt', baseURL ?? ON_ORIGIN).href);
      await page.evaluate(
        ({ key, value }) => {
          localStorage.setItem(key, value);
        },
        { key: themeStorageKey, value: theme },
      );
      await page.close();
      mkdirSync(REPORTS, { recursive: true });
    });

    test.afterAll(async () => {
      await context.close();
      rmSync(profile, { recursive: true, force: true });
    });

    for (const path of PATHS) {
      test(`${path} scores ${String(MINIMUM_SCORE)} or more`, async ({ baseURL }) => {
        test.setTimeout(120_000);
        const url = new URL(path, baseURL ?? ON_ORIGIN).href;
        const result = await lighthouse(url, {
          port: DEBUG_PORT,
          logLevel: 'error',
          output: 'json',
          onlyCategories: [...CATEGORIES],
          // Keeps the session and the stored theme, which are the point of this run.
          disableStorageReset: true,
          formFactor: 'desktop',
          screenEmulation: { mobile: false, ...DESKTOP, deviceScaleFactor: 1, disabled: false },
          throttlingMethod: 'provided',
          // The desktop waits suit a slowed load. Here 5 s a page is 3 minutes of nothing.
          pauseAfterFcpMs: SETTLE_MS,
          pauseAfterLoadMs: SETTLE_MS,
          networkQuietThresholdMs: SETTLE_MS,
          cpuQuietThresholdMs: SETTLE_MS,
        });
        if (result === undefined) throw new Error(`Lighthouse gave no result for ${path}`);
        const { lhr, report } = result;
        writeFileSync(join(REPORTS, fileName(path, theme)), String(report));
        expect(lhr.runtimeError, 'Lighthouse ran').toBeUndefined();
        expect(new URL(lhr.finalDisplayedUrl).pathname, 'stayed on the route').toBe(path);

        const page = await context.newPage();
        await page.goto(url, { waitUntil: 'commit' });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.close();

        const scores = CATEGORIES.map((category) => ({
          category,
          score: Math.round((lhr.categories[category]?.score ?? 0) * 100),
        }));
        console.log(
          `lighthouse ${theme} ${path}: ${scores.map((s) => `${s.category} ${String(s.score)}`).join(', ')}`,
        );
        const failing = Object.values(lhr.audits)
          .filter((audit) => audit.score !== null && audit.score < 1)
          .map((audit) => audit.id);
        for (const { category, score } of scores) {
          expect(
            score,
            `${category}; failing audits: ${failing.join(', ')}`,
          ).toBeGreaterThanOrEqual(MINIMUM_SCORE);
        }
      });
    }
  });
}
