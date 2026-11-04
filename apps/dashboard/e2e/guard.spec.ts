import { expect } from '@playwright/test';
import { commandBar, ON_ORIGIN, openShell } from './fixtures.ts';
import { expectTitleLeaksNothing, FIXTURE_WORDS } from './leaks.ts';
import { ADA, MAYA, NOOR, SAM, SIGNED_OUT, stateFile, ZARA } from './people.ts';
import { test } from './test.ts';

test.describe('signed out', () => {
  test.use({ storageState: SIGNED_OUT });

  test('a known and an unknown slug get the same redirect', async ({ request }) => {
    const known = await request.get('/acme/docs', { maxRedirects: 0 });
    const unknown = await request.get('/zzz/docs', { maxRedirects: 0 });
    expect(known.status()).toBe(307);
    expect(unknown.status()).toBe(307);
    expect(known.headers()['location']).toBe('/sign-in?next=%2Facme%2Fdocs');
    expect(unknown.headers()['location']).toBe('/sign-in?next=%2Fzzz%2Fdocs');
  });

  test('a forged path header cannot change next', async ({ request }) => {
    const response = await request.get('/acme', {
      maxRedirects: 0,
      headers: { 'x-drefyn-request-path': '//evil.test/' },
    });
    expect(response.headers()['location']).toBe('/sign-in?next=%2Facme');
  });

  test('the query stays in next', async ({ request }) => {
    const response = await request.get('/acme/docs?tab=a', { maxRedirects: 0 });
    expect(response.headers()['location']).toBe('/sign-in?next=%2Facme%2Fdocs%3Ftab%3Da');
  });

  test('/ redirects to sign in', async ({ request }) => {
    const response = await request.get('/', { maxRedirects: 0 });
    expect(response.headers()['location']).toBe('/sign-in?next=%2F');
  });

  test('/bundle-baseline renders with no session', async ({ request }) => {
    expect((await request.get('/bundle-baseline')).status()).toBe(200);
  });
});

test.describe('a non member', () => {
  test.use({ storageState: stateFile(NOOR) });

  for (const path of ['/acme', '/acme/docs', '/acme/settings/plan', '/zzz']) {
    test(`${path} is a 404 with no organization or page data`, async ({ request, page }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(404);
      const body = await response.text();
      expect(FIXTURE_WORDS.filter((word) => body.includes(word))).toEqual([]);
      await expectTitleLeaksNothing(page, path);
    });
  }

  test('beta, targeted off in the flag file, is a 404 for its own owner', async ({ request }) => {
    expect((await request.get('/beta', { maxRedirects: 0 })).status()).toBe(404);
  });
});

test.describe('an owner', () => {
  test.use({ storageState: stateFile(MAYA) });

  test('sees acme while beta stays off', async ({ request }) => {
    expect((await request.get('/acme', { maxRedirects: 0 })).status()).toBe(200);
    expect((await request.get('/beta', { maxRedirects: 0 })).status()).toBe(404);
  });

  test('/ lands on the first organization', async ({ request }) => {
    const response = await request.get('/', { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    expect(response.headers()['location']).toBe('/acme');
  });

  test('the shell shows the seeded organization and person', async ({ page }) => {
    await openShell(page, '/acme');
    await expect(page.getByRole('button', { name: /account for Maya Okafor/ })).toBeVisible();
  });
});

test.describe('a person with no organization', () => {
  test.use({ storageState: stateFile(ZARA) });

  test('/ is a 404', async ({ request }) => {
    expect((await request.get('/', { maxRedirects: 0 })).status()).toBe(404);
  });
});

async function barEntries(page: Parameters<typeof openShell>[0]): Promise<string[]> {
  await openShell(page, '/acme');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(commandBar(page)).toBeVisible();
  return commandBar(page).getByRole('option').allTextContents();
}

test.describe('command bar by role', () => {
  test.describe('member', () => {
    test.use({ storageState: stateFile(SAM) });

    test('sees only what the role allows, and the server refuses the rest', async ({
      page,
      request,
    }) => {
      const entries = await barEntries(page);
      expect(entries).toHaveLength(4);
      expect(entries.join(' ')).not.toContain('Payments API');
      expect((await request.get('/acme/docs', { maxRedirects: 0 })).status()).toBe(404);
      const project = await request.get('/acme/docs/payments-api', { maxRedirects: 0 });
      expect(project.status()).toBe(404);
    });
  });

  test.describe('admin', () => {
    test.use({ storageState: stateFile(ADA) });

    test('sees more than a member', async ({ page }) => {
      expect((await barEntries(page)).length).toBeGreaterThan(4);
    });
  });
});

test('the URL check goes red on a bad Location and a bad link', async ({ page, urlProblems }) => {
  await page.route(`${ON_ORIGIN}/bad-page`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<a href="http://evil.test/link">x</a>',
    }),
  );
  await page.route(`${ON_ORIGIN}/bad-location`, (route) =>
    route.fulfill({ status: 302, headers: { location: 'http://evil.test/moved' } }),
  );
  await page.goto('/bad-page');
  await page.goto('/bad-location').catch(() => undefined);
  await expect.poll(() => urlProblems.length).toBeGreaterThanOrEqual(2);
  expect(urlProblems).toContain('http://evil.test/link');
  expect(urlProblems).toContain('http://evil.test/moved');
  // Drained, or the watcher fails this test for doing its job.
  urlProblems.length = 0;
});
