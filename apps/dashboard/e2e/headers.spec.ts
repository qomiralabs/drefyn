import { expect, type Page } from '@playwright/test';
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

// Headers only: the loading fixture streams forever, so the body is never read.
async function headersOf(path: string): Promise<Headers> {
  const base = test.info().project.use.baseURL ?? '';
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 10_000);
  try {
    const res = await fetch(new URL(path, base), {
      redirect: 'manual',
      signal: controller.signal,
    });
    void res.body?.cancel();
    return res.headers;
  } finally {
    clearTimeout(timer);
  }
}

for (const path of PATHS) {
  test(`${path} sends every security header with its exact value`, async () => {
    const headers = await headersOf(path);
    const nonce = nonceIn(headers.get('content-security-policy'));
    expect(nonce).toMatch(NONCE);
    expect(headers.get('content-security-policy')).toBe(policy(nonce));
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('referrer-policy')).toBe(
      NO_REFERRER.has(path) ? 'no-referrer' : 'strict-origin-when-cross-origin',
    );
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    );
    // The test servers listen on http loopback, where HSTS would pin a dev machine.
    expect(headers.get('strict-transport-security')).toBeNull();
  });
}

test('each response has its own nonce', async () => {
  const nonces = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    nonces.add(nonceIn((await headersOf('/acme')).get('content-security-policy')));
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
    // The loading fixture never finishes on purpose, so its load event never fires. Its
    // shell still hydrates, so it is checked like the rest.
    await page.goto(path, { waitUntil: 'commit' });
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
