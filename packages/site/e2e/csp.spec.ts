import { expect, test, type Page } from '@playwright/test';
import { ORIGIN, PAGES, SCRIPTS, tamper, type BuiltPage } from './pages.ts';

type Delivery = 'header and meta' | 'header only' | 'meta only';

interface Violation {
  directive: string;
  blocked: string;
}

declare global {
  interface Window {
    __violations: Violation[];
    __pwned?: string;
  }
}

const META = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/;

// Runs before any page script, outside the page's policy, so the page cannot hide from it.
function watch(page: Page): string[] {
  const console: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') console.push(message.text());
  });
  page.on('pageerror', (error) => console.push(error.message));
  void page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__violations.push({
        directive: event.effectiveDirective || event.violatedDirective,
        blocked: event.blockedURI,
      });
    });
    try {
      localStorage.setItem('dr-theme', 'dark');
    } catch {
      // A browser without storage still runs the rest of the test.
    }
  });
  return console;
}

async function serve(page: Page, built: BuiltPage, html: string, delivery: Delivery) {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    const script = SCRIPTS[url.pathname];
    if (url.pathname === built.path) {
      const body = delivery === 'header only' ? html.replace(META, '') : html;
      const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' };
      if (delivery !== 'meta only') headers['content-security-policy'] = built.csp;
      await route.fulfill({ status: 200, headers, body });
    } else if (script !== undefined) {
      await route.fulfill({ status: 200, contentType: 'text/javascript', body: script });
    } else {
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    }
  });
}

// Violation events are queued as tasks while the page parses. Two frames and a task after
// load is the same wait for the clean pages and for the control that must report.
async function settled(page: Page): Promise<Violation[]> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
      }),
  );
  return page.evaluate(() => window.__violations);
}

for (const built of PAGES) {
  test.describe(built.kind, () => {
    test('holds its policy with no violation, and every allowed script and style applies', async ({
      page,
    }) => {
      const console = watch(page);
      await serve(page, built, built.html, 'header and meta');
      await page.goto(`${ORIGIN}${built.path}`);

      expect(await settled(page)).toEqual([]);
      expect(console).toEqual([]);
      const state = await page.evaluate(() => ({
        theme: document.documentElement.dataset['theme'],
        scriptRan: document.documentElement.dataset['scriptRan'],
        ink: getComputedStyle(document.documentElement).getPropertyValue('--dr-text-ink').trim(),
      }));
      // The hashed theme line ran, the inline stylesheet and theme applied, and the plain
      // script loaded.
      expect(state.theme).toBe('dark');
      expect(state.ink).toBe('#F5F5F4');
      expect(state.scriptRan).toBe(built.script?.slice(1, -3));
    });

    // The control: one byte off in each inline element must be refused and reported with the
    // same wait the clean test uses, or a clean result above would prove nothing.
    test('reports a theme line or stylesheet that drifted from its hash', async ({ page }) => {
      watch(page);
      const drifted = built.html
        .replace('<script>try{', '<script> try{')
        .replace('<style>', '<style> ');
      await serve(page, built, drifted, 'header and meta');
      await page.goto(`${ORIGIN}${built.path}`);

      const violations = await settled(page);
      const directives = new Set(violations.map((v) => v.directive.replace(/-elem$/, '')));
      expect([...directives].sort()).toEqual(['script-src', 'style-src']);
      expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBeUndefined();
    });

    for (const delivery of ['header and meta', 'header only', 'meta only'] as const) {
      test(`runs no injected script or style, by ${delivery}, and reports each`, async ({
        page,
      }) => {
        watch(page);
        await serve(page, built, tamper(built.html), delivery);
        await page.goto(`${ORIGIN}${built.path}`);

        const violations = await settled(page);
        expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
        const directives = new Set(
          violations.map((v) => v.directive.replace(/-(?:elem|attr)$/, '')),
        );
        expect([...directives].sort()).toEqual(['script-src', 'style-src']);
        // At least the inline script, the data script, the handler, the style element and
        // the style attribute.
        expect(violations.length).toBeGreaterThanOrEqual(5);
        const colors = await page.evaluate(() => ({
          page: getComputedStyle(document.querySelector('main') ?? document.body).color,
          styled: getComputedStyle(document.getElementById('styled') ?? document.body).color,
        }));
        expect(colors.page).not.toBe('rgb(255, 0, 0)');
        expect(colors.styled).not.toBe('rgb(255, 0, 0)');
        // The page itself still works under the tampering.
        expect(await page.evaluate(() => document.documentElement.dataset['theme'])).toBe('dark');
      });
    }
  });
}
