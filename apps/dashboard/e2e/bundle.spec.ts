import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { expect, type Browser, type BrowserContextOptions } from '@playwright/test';
import {
  KB,
  baselineReport,
  routeReport,
  type RouteReport,
  type ScriptSize,
} from '../src/bundle/budget.ts';
import { COMMAND_BAR_MARK, OPEN_ORIGIN, ROUTES } from './fixtures.ts';
import { MAYA, SIGNED_OUT, stateFile, ZARA } from './people.ts';
import { test } from './test.ts';

const BASELINE_ROUTE = '/bundle-baseline';
const SIGN_IN_BUDGET_BYTES = 30 * KB;
const recorded = JSON.parse(
  readFileSync(new URL('../bundle-baseline.json', import.meta.url), 'utf8'),
) as { gzipBytes: number };

// A cold load in a fresh context, every script response gzipped at level 9, up to the
// point the network goes quiet and before any input.
async function coldLoad(
  browser: Browser,
  path: string,
  storageState: NonNullable<BrowserContextOptions['storageState']>,
): Promise<ScriptSize[]> {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const pending: Promise<ScriptSize>[] = [];
  page.on('response', (res) => {
    if (res.request().resourceType() !== 'script') return;
    pending.push(
      res
        .body()
        .then((body) => ({ url: res.url(), gzipBytes: gzipSync(body, { level: 9 }).length })),
    );
  });
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  const scripts = await Promise.all(pending);
  await context.close();
  return scripts;
}

// The scripts of a cold load that carry the command bar's own text, by URL.
async function commandBarScripts(
  browser: Browser,
  path: string,
  storageState: NonNullable<BrowserContextOptions['storageState']>,
): Promise<string[]> {
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const pending: Promise<string | null>[] = [];
  page.on('response', (res) => {
    if (res.request().resourceType() !== 'script') return;
    pending.push(
      res
        .text()
        .then((body) => (body.includes(COMMAND_BAR_MARK) ? res.url() : null))
        .catch(() => null),
    );
  });
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  const found = (await Promise.all(pending)).filter((url): url is string => url !== null);
  await context.close();
  return found;
}

const SHELL_ROUTES = [
  ROUTES.overview,
  ROUTES.project,
  ROUTES.empty,
  ROUTES.success,
  ROUTES.error,
  '/acme/settings/members',
  '/acme/settings/api-keys',
  '/account',
  '/account/sign-in',
  '/account/sessions',
] as const;

const kb = (bytes: number) => `${(bytes / KB).toFixed(1)} KB`;

test.describe.configure({ mode: 'serial' });

test('every shell route stays under 150 KB beyond the framework baseline', async ({ browser }) => {
  const baseline = await coldLoad(browser, BASELINE_ROUTE, SIGNED_OUT);
  expect(baseline.length, 'the baseline route loads the framework').toBeGreaterThan(0);
  const reports: RouteReport[] = [];
  for (const path of SHELL_ROUTES) {
    reports.push(routeReport(path, await coldLoad(browser, path, stateFile(MAYA)), baseline));
  }
  console.log(
    reports
      .map(
        (r) =>
          `${r.route}: ${kb(r.beyondBaselineBytes)} beyond baseline, ${kb(r.totalBytes)} total`,
      )
      .join('\n'),
  );
  // The shell itself is real code, so a route that adds nothing means the count is broken.
  for (const r of reports) expect(r.beyondBaselineBytes, r.route).toBeGreaterThan(0);
  expect(reports.filter((r) => r.overBudget).map((r) => r.route)).toEqual([]);
});

// Its frame opens on the first press, so only the results code may wait for that press.
test("the command bar results are in no route's initial load", async ({ browser }) => {
  const found: string[] = [];
  for (const path of SHELL_ROUTES) {
    found.push(
      ...(await commandBarScripts(browser, path, stateFile(MAYA))).map((u) => `${path}: ${u}`),
    );
  }
  expect(found).toEqual([]);
});

test('the framework baseline has not grown more than 5 percent', async ({ browser }) => {
  const baseline = await coldLoad(browser, BASELINE_ROUTE, SIGNED_OUT);
  const measured = baseline.reduce((sum, s) => sum + s.gzipBytes, 0);
  const report = baselineReport(recorded.gzipBytes, measured);
  console.log(
    `baseline ${kb(measured)}, recorded ${kb(recorded.gzipBytes)}, growth ${(report.growth * 100).toFixed(1)} percent`,
  );
  expect(report.ok).toBe(true);
});

test('sign in stays under 30 KB beyond the framework baseline', async ({ browser }) => {
  const baseline = await coldLoad(browser, BASELINE_ROUTE, SIGNED_OUT);
  const report = routeReport('/sign-in', await coldLoad(browser, '/sign-in', SIGNED_OUT), baseline);
  console.log(`/sign-in: ${kb(report.beyondBaselineBytes)} beyond baseline`);
  expect(report.beyondBaselineBytes).toBeGreaterThan(0);
  expect(report.beyondBaselineBytes).toBeLessThan(SIGN_IN_BUDGET_BYTES);
});

// Welcome shares this page's one client file, so measuring one measures both.
test('the first run pages stay under 150 KB beyond the framework baseline', async ({ browser }) => {
  // The same server, because scripts are matched to the baseline by URL.
  const baseline = await coldLoad(browser, `${OPEN_ORIGIN}${BASELINE_ROUTE}`, SIGNED_OUT);
  const path = `${OPEN_ORIGIN}/organizations/new`;
  const report = routeReport(path, await coldLoad(browser, path, stateFile(ZARA)), baseline);
  console.log(`${path}: ${kb(report.beyondBaselineBytes)} beyond baseline`);
  expect(report.beyondBaselineBytes).toBeGreaterThan(0);
  expect(report.overBudget).toBe(false);
});

// Mail loads through Node at run time, so a browser must never be sent a byte of it.
test('no client chunk holds mail code', () => {
  const root = new URL('../.next/static/', import.meta.url);
  const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) =>
    f.endsWith('.js'),
  );
  expect(files.length, 'the build wrote client chunks').toBeGreaterThan(0);
  const holding = files.filter((f) =>
    /nodemailer|MailDocument/.test(readFileSync(new URL(f, root), 'utf8')),
  );
  expect(holding).toEqual([]);
});
