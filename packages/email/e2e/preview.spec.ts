import { readFileSync, readdirSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { PREVIEW_DIR } from '../tools/preview.ts';

// Run `pnpm --filter @drefyn/email preview` first.
const ids = readdirSync(PREVIEW_DIR)
  .filter((name) => name.endsWith('.html') && name !== 'index.html')
  .map((name) => name.replace(/\.html$/, ''));

// Best practice rules expect a page. A mail body sits inside the client's own main, so the
// gate is the WCAG tags alone.
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ALLOWED = ['data:', 'about:'];

const modes = [
  { name: 'light', scheme: 'light', width: 1024, strip: false },
  { name: 'dark', scheme: 'dark', width: 1024, strip: false },
  { name: 'stripped', scheme: 'light', width: 1024, strip: true },
  { name: 'light 390', scheme: 'light', width: 390, strip: false },
  { name: 'dark 390', scheme: 'dark', width: 390, strip: false },
] as const;

const html = (id: string): string => readFileSync(`${PREVIEW_DIR}/${id}.html`, 'utf8');

async function open(page: Page, id: string, mode: (typeof modes)[number]): Promise<string[]> {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (!ALLOWED.some((scheme) => request.url().startsWith(scheme))) {
      requests.push(request.url());
    }
  });
  await page.emulateMedia({ colorScheme: mode.scheme });
  await page.setViewportSize({ width: mode.width, height: 900 });
  await page.setContent(html(id));
  // Through the DOM, the way a client that drops head styles sees it.
  if (mode.strip) {
    await page.locator('style').evaluateAll((styles) => {
      for (const style of styles) style.remove();
    });
  }
  return requests;
}

test.describe('every mail', () => {
  for (const id of ids) {
    for (const mode of modes) {
      test(`${id} in ${mode.name} has no WCAG violations and fetches nothing`, async ({ page }) => {
        const requests = await open(page, id, mode);
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        expect(results.violations.map((v) => v.id)).toEqual([]);
        expect(requests).toEqual([]);
        const scroll = await page.evaluate(() => {
          const root = document.documentElement;
          return root.scrollWidth - root.clientWidth;
        });
        expect(scroll).toBeLessThanOrEqual(0);
      });
    }

    test(`${id} keeps the folio on one line at 390 px`, async ({ page }) => {
      await open(page, id, modes[3]);
      const heights = await page.locator('.dr-folio, .dr-folio-label').evaluateAll((cells) =>
        cells.map((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return range.getClientRects().length;
        }),
      );
      expect(heights).toEqual([1, 1]);
    });

    test(`${id} has links at least 24 px tall`, async ({ page }) => {
      await open(page, id, modes[3]);
      const links = page.locator('a');
      for (const link of await links.all()) {
        const lines = await link.evaluate((a) =>
          Number.parseFloat(getComputedStyle(a.parentElement ?? a).lineHeight),
        );
        expect(lines).toBeGreaterThanOrEqual(24);
      }
    });
  }

  test('a click selects the eight digits of the code', async ({ page }) => {
    await open(page, 'sign_in_code.sign_in', modes[0]);
    await page.locator('.dr-code').click();
    const selected = await page.evaluate(() => getSelection()?.toString());
    expect(selected?.replace(/\n/g, '')).toBe('24681357');
  });
});
