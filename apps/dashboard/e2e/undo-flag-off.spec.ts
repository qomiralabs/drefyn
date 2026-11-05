import { expect } from '@playwright/test';
import { OFF_ORIGIN, ON_ORIGIN } from './fixtures.ts';
import { MAYA, stateFile } from './people.ts';
import { test } from './test.ts';
import { archive, openPages, PAGES, select } from './undo-helpers.ts';

// With the flag off the working view and its write are both gone.
test('the Pages view is a 404', async ({ request }) => {
  const response = await request.get(PAGES);
  expect(response.status()).toBe(404);
});

test('the write answers 404 to a member with the real action id', async ({ browser, request }) => {
  // The id exists only in a build's client code, so it is read from the server with the flag on.
  const context = await browser.newContext({ baseURL: ON_ORIGIN, storageState: stateFile(MAYA) });
  const page = await context.newPage();
  await openPages(page);
  await select(page, 'Refunds');
  const write = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(PAGES));
  await archive(page).click();
  const sent = await write;
  const action = (await sent.allHeaders())['next-action'] ?? '';
  const data = sent.postData() ?? '';
  await context.close();
  expect(action).not.toBe('');
  const response = await request.post(`${OFF_ORIGIN}${PAGES}`, {
    headers: { origin: OFF_ORIGIN, 'next-action': action, 'content-type': 'text/plain' },
    data,
  });
  expect(response.status()).toBe(404);
});
