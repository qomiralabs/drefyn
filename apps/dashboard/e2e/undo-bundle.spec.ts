import { gzipSync } from 'node:zlib';
import { expect, type Browser } from '@playwright/test';
import { KB, routeReport, type ScriptSize } from '../src/bundle/budget.ts';
import { MAYA, SIGNED_OUT, stateFile } from './people.ts';
import { test } from './test.ts';
import { PAGES } from './undo-helpers.ts';

async function coldLoad(browser: Browser, path: string, state: string | typeof SIGNED_OUT) {
  const context = await browser.newContext({ storageState: state });
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

// The grid is the heaviest thing a shell route has pulled in so far.
test('the Pages view stays under 150 KB beyond the framework baseline', async ({ browser }) => {
  const baseline = await coldLoad(browser, '/bundle-baseline', SIGNED_OUT);
  const report = routeReport(PAGES, await coldLoad(browser, PAGES, stateFile(MAYA)), baseline);
  console.log(`${PAGES}: ${(report.beyondBaselineBytes / KB).toFixed(1)} KB beyond baseline`);
  expect(report.beyondBaselineBytes).toBeGreaterThan(0);
  expect(report.overBudget).toBe(false);
});
