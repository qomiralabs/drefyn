import { expect } from '@playwright/test';
import { ROUTES } from './fixtures.ts';
import {
  expectBodyLeaksNothing,
  expectTitleLeaksNothing,
  LEAK_PATHS,
  UNKNOWN_ORG_PATHS,
} from './leaks.ts';
import { MAYA, stateFile, ZARA } from './people.ts';
import { test } from './test.ts';

// This project runs against the server started with dashboard.shell off.
const SIGNED_OUT_PAGES = [
  '/sign-in',
  '/sign-up',
  '/sign-in/verify',
  '/sign-in/password',
  '/sign-in/reset',
  '/sign-in/link',
  '/sign-in/cli',
  '/welcome',
  '/organizations/new',
  '/invite',
  '/invite/block',
  '/auth-states/sign-in/ready',
  '/settings-states/members/ready',
];
// Route handlers, so a 404 here has no page to carry a title.
const SIGNED_OUT_ROUTES = [
  '/auth/pre',
  '/auth/oauth/github/start',
  '/auth/oauth/github/callback',
  '/settings-states/whoami',
];
const paths = [
  '/',
  ...Object.values(ROUTES),
  '/acme/docs',
  '/acme/status',
  '/bundle-baseline',
  ...SIGNED_OUT_PAGES,
];

for (const path of paths) {
  test(`${path} is 404 with the release flag off`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
  });
}

for (const path of SIGNED_OUT_ROUTES) {
  test(`${path} is 404 and sets no cookie with the release flag off`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    expect(res.status()).toBe(404);
    expect(res.headers()['set-cookie']).toBeUndefined();
  });
}

test('the 404 page carries no shell, so nothing about the dashboard leaks', async ({ page }) => {
  await page.goto(ROUTES.overview);
  await expect(page.getByRole('banner')).toHaveCount(0);
  await expect(page.getByText('Acme')).toHaveCount(0);
  await expect(page.getByText('Maya Okafor')).toHaveCount(0);
});

// Pages render next to their layout, so a check in the layout alone still streams the page.
for (const path of [...LEAK_PATHS, ...UNKNOWN_ORG_PATHS]) {
  test(`${path} with the flag off sends no page content and no page title`, async ({
    request,
    page,
  }) => {
    await expectBodyLeaksNothing(request, path);
    await expectTitleLeaksNothing(page, path);
  });
}

// The person the first run pages are for gets the same 404 as anyone else.
test.describe('signed in, with no organization', () => {
  test.use({ storageState: stateFile(ZARA) });

  for (const path of ['/', '/welcome', '/organizations/new']) {
    test(`${path} is a 404 with no page content`, async ({ request, page }) => {
      await expectBodyLeaksNothing(request, path);
      await expectTitleLeaksNothing(page, path);
    });
  }
});

// A valid session changes nothing: with the flag off there is no dashboard for anyone.
test.describe('signed in', () => {
  test.use({ storageState: stateFile(MAYA) });

  for (const path of new Set([...paths, ...LEAK_PATHS, ...UNKNOWN_ORG_PATHS])) {
    test(`${path} with a valid session is a 404 with no page content`, async ({
      request,
      page,
    }) => {
      await expectBodyLeaksNothing(request, path);
      await expectTitleLeaksNothing(page, path);
    });
  }
});
