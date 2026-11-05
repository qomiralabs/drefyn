import { expect, type Locator, type Page, type Route } from '@playwright/test';
import { openShell } from './fixtures.ts';

export const PAGES = '/acme/docs/payments-api/pages';

export const pagesTable = (page: Page): Locator => page.getByRole('grid', { name: 'Pages' });
export const row = (page: Page, title: string): Locator =>
  pagesTable(page).getByRole('row', { name: new RegExp(title) });
export const archive = (page: Page): Locator =>
  page.getByRole('main').getByRole('button', { name: 'Archive', exact: true });
export const toastRegion = (page: Page): Locator =>
  page.getByRole('region', { name: /notification/i });

// React Aria's real input sits under the drawn box, which is what a pointer lands on.
const BOX = '[data-box]';

export async function selectAll(page: Page): Promise<void> {
  await pagesTable(page).getByRole('columnheader').first().locator(BOX).click();
}

export async function openPages(page: Page): Promise<void> {
  await openShell(page, PAGES);
  await expect(pagesTable(page)).toBeVisible();
}

export async function select(page: Page, title: string): Promise<void> {
  await row(page, title).locator(BOX).click();
}

const isWrite = (route: Route) => route.request().method() === 'POST';

// The server refuses every write. A Server Action posts to the page's own URL.
export async function refuseWrites(page: Page): Promise<void> {
  await page.route(`**${PAGES}`, (route) =>
    isWrite(route) ? route.fulfill({ status: 500, body: 'refused' }) : route.fallback(),
  );
}

// Holds every write until the returned function is called, so a spec can look at the page
// while the server has not answered.
export async function holdWrites(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${PAGES}`, async (route) => {
    if (!isWrite(route)) {
      await route.fallback();
      return;
    }
    await released;
    await route.continue();
  });
  return release;
}
