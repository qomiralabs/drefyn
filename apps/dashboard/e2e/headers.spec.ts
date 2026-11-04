import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { test } from './csp.ts';
import { banner, commandBar, DESKTOP, MOBILE } from './fixtures.ts';
import { LEAK_PATHS, UNKNOWN_ORG_PATHS } from './leaks.ts';

// Runs in the shell engine projects against the flag on server, and in flag-off against
// the server with the release flag off, where every one of these routes is a 404.
const flagOn = () => test.info().project.name !== 'flag-off';

const NONCE = /^[A-Za-z0-9+/]{22}==$/;
const policy = (nonce: string) =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; ` +
  `style-src 'self' 'nonce-${nonce}'; frame-ancestors 'none'; form-action 'self'; ` +
  `base-uri 'none'; object-src 'none'`;

// Pages, the bare root, not found pages, and the auth paths that have no page yet. Static
// files are included: the headers do not depend on what answered.
const PATHS = [
  '/',
  ...LEAK_PATHS,
  ...UNKNOWN_ORG_PATHS,
  '/acme/docs/missing',
  '/sign-in',
  '/sign-in/verify',
  '/invite',
  '/invite/block',
  '/robots.txt',
  '/icon.svg',
] as const;
const NO_REFERRER = new Set<string>(['/sign-in/verify', '/invite', '/invite/block']);

const nonceIn = (csp: string | null | undefined): string =>
  /'nonce-([^']+)'/.exec(csp ?? '')?.[1] ?? '';

type Method = 'GET' | 'HEAD';

async function headersOf(
  request: APIRequestContext,
  path: string,
  method: Method = 'HEAD',
  headers: Record<string, string> = {},
): Promise<Record<string, string | undefined>> {
  const res = await request.fetch(path, { method, headers, maxRedirects: 0, timeout: 10_000 });
  return res.headers();
}

for (const path of PATHS) {
  for (const method of ['HEAD', 'GET'] as const) {
    test(`${method} ${path} sends every security header with its exact value`, async ({
      request,
    }) => {
      const headers = await headersOf(request, path, method);
      const nonce = nonceIn(headers['content-security-policy']);
      expect(nonce).toMatch(NONCE);
      expect(headers['content-security-policy']).toBe(policy(nonce));
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe(
        NO_REFERRER.has(path) ? 'same-origin' : 'strict-origin-when-cross-origin',
      );
      expect(headers['cache-control']).toBe('no-store');
      expect(headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(headers['permissions-policy']).toBe(
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      );
      // The test servers listen on http loopback, where HSTS would pin a dev machine.
      expect(headers['strict-transport-security']).toBeUndefined();
    });
  }
}

test('build output keeps its long cache, is nosniff, and carries no policy', async ({
  page,
  request,
}) => {
  const chunks: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/_next/static/') && req.url().endsWith('.js')) chunks.push(req.url());
  });
  await page.goto(flagOn() ? '/acme' : '/nope');
  expect(chunks.length).toBeGreaterThan(0);
  const headers = await headersOf(request, new URL(chunks[0] ?? '').pathname, 'GET');
  expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy']).toBeUndefined();
});

test('HSTS follows the configured origin, not a forwarded scheme', async ({ request }) => {
  const headers = await headersOf(request, '/acme', 'GET', { 'x-forwarded-proto': 'https' });
  expect(headers['strict-transport-security']).toBeUndefined();
});

test('each response has its own nonce', async ({ request }) => {
  const nonces = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    nonces.add(nonceIn((await headersOf(request, '/acme', 'GET'))['content-security-policy']));
  }
  expect(nonces.size).toBe(5);
});

// The meta tag is where React Aria finds the nonce for the style it injects. The browser
// hides a nonce attribute once parsed, so later script cannot copy it from the DOM.
async function pageNonce(page: Page) {
  return page.locator('meta[name="csp-nonce"]').evaluate((el: HTMLMetaElement) => ({
    property: el.nonce,
    attribute: el.getAttribute('nonce'),
    content: el.getAttribute('content'),
  }));
}

test('the page carries the response nonce on a hidden meta tag', async ({ page }) => {
  const res = await page.goto('/acme');
  expect(res).not.toBeNull();
  const nonce = nonceIn((await res?.allHeaders())?.['content-security-policy']);
  expect(nonce).toMatch(NONCE);
  expect(await pageNonce(page)).toEqual({ property: nonce, attribute: '', content: null });
});

test('a nonce the client sends is ignored', async ({ page }) => {
  await page.setExtraHTTPHeaders({
    'x-drefyn-nonce': 'AAAAAAAAAAAAAAAAAAAAAA==',
    'content-security-policy': "script-src 'nonce-AAAAAAAAAAAAAAAAAAAAAA=='",
  });
  const res = await page.goto('/acme');
  const nonce = nonceIn((await res?.allHeaders())?.['content-security-policy']);
  expect(nonce).toMatch(NONCE);
  expect(nonce).not.toBe('AAAAAAAAAAAAAAAAAAAAAA==');
  expect((await pageNonce(page)).property).toBe(nonce);
});

test('an inline script without the nonce does not run, one with it does', async ({
  page,
  cspViolations,
}) => {
  await page.route('**/acme', async (route) => {
    const res = await route.fetch();
    const nonce = nonceIn(res.headers()['content-security-policy']);
    const body = (await res.text()).replace(
      '</head>',
      '<script>window.__injected = true</script>' +
        `<script nonce="${nonce}">window.__trusted = true</script></head>`,
    );
    await route.fulfill({ response: res, body });
  });
  await page.goto('/acme');
  const ran = await page.evaluate(() => {
    const w = window as unknown as { __injected?: boolean; __trusted?: boolean };
    return { injected: w.__injected === true, trusted: w.__trusted === true };
  });
  expect(ran).toEqual({ injected: false, trusted: true });
  await expect
    .poll(() => cspViolations.some((v) => v.directive.startsWith('script-src')))
    .toBe(true);
  cspViolations.length = 0;
});

// Opens everything that draws on top of the page, so any style or script React Aria injects
// for them is loaded under the policy.
async function openOverlays(page: Page): Promise<void> {
  await banner(page).getByRole('button', { name: 'Search or run a command' }).click();
  await expect(commandBar(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(commandBar(page)).toBeHidden();

  await banner(page)
    .getByRole('button', { name: /^Inbox/ })
    .click();
  await expect(page.getByRole('dialog', { name: 'Inbox' })).toBeVisible();
  await page.keyboard.press('Escape');

  for (const [trigger, name] of [
    [/^MO/, 'Account'],
    [/^Acme/, 'Organization'],
  ] as const) {
    await banner(page).getByRole('button', { name: trigger }).click();
    await expect(page.getByRole('menu', { name })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name })).toBeHidden();
  }
}

for (const path of LEAK_PATHS) {
  test(`${path} loads with no CSP violation, overlays and drawer open`, async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    if (!flagOn()) {
      const res = await page.goto(path);
      expect(res?.status()).toBe(404);
      await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
      return;
    }
    await page.goto(path);
    await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
    await openOverlays(page);
    await page.setViewportSize(MOBILE);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('button', { name: 'Close navigation' })).toBeVisible();
    await page.getByRole('button', { name: 'Close navigation' }).click();
  });
}

test('a not found page loads with no CSP violation', async ({ page }) => {
  const res = await page.goto('/nope');
  expect(res?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
});
