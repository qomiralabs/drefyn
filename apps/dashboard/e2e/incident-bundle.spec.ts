import { expect, type Browser, type Page } from '@playwright/test';
import { commandBar, openShell, ROUTES } from './fixtures.ts';
import { COCKPIT, COCKPIT_MARK, heading, startFromCommandBar, STATUS } from './incident-helpers.ts';
import { MAYA, stateFile } from './people.ts';
import { test } from './test.ts';

function scriptsOf(page: Page): { pending: Promise<{ url: string; text: string }>[] } {
  const seen = { pending: [] as Promise<{ url: string; text: string }>[] };
  page.on('response', (res) => {
    if (res.request().resourceType() !== 'script') return;
    // A script still arriving as the test ends has no body to read, and cannot be the chunk
    // the test already found.
    seen.pending.push(
      res
        .text()
        .catch(() => '')
        .then((text) => ({ url: res.url(), text })),
    );
  });
  return seen;
}

async function coldLoad(browser: Browser, path: string): Promise<string[]> {
  const context = await browser.newContext({ storageState: stateFile(MAYA) });
  const page = await context.newPage();
  const seen = scriptsOf(page);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  const scripts = await Promise.all(seen.pending);
  await context.close();
  return scripts.filter((s) => s.text.includes(COCKPIT_MARK)).map((s) => s.url);
}

const ROUTE_LIST = [
  ROUTES.overview,
  ROUTES.project,
  ROUTES.empty,
  ROUTES.error,
  STATUS,
  `${STATUS}/incidents`,
  // Its own URL too: the shell reaches the cockpit only once it knows one is open.
  COCKPIT,
  '/acme/settings/members',
  '/account',
];

test('no route has the cockpit in its first load', async ({ browser }) => {
  const listing: string[] = [];
  for (const path of ROUTE_LIST) {
    const found = await coldLoad(browser, path);
    listing.push(`${path}: ${found.length === 0 ? 'no cockpit code' : found.join(', ')}`);
    expect(found, path).toEqual([]);
  }
  console.log(listing.join('\n'));
});

test('the cockpit arrives as its own chunk when an incident opens', async ({ page }) => {
  await openShell(page, STATUS);
  const seen = scriptsOf(page);
  await startFromCommandBar(page);
  await expect(commandBar(page)).toHaveCount(0);
  await expect(heading(page)).toBeVisible();
  await expect(page).toHaveURL(COCKPIT);
  await page.waitForLoadState('networkidle');
  const scripts = await Promise.all(seen.pending);
  expect(scripts.filter((s) => s.text.includes(COCKPIT_MARK))).toHaveLength(1);
});
