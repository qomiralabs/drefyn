import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page } from '@playwright/test';

const STATIC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'storybook-static');

// A .localhost name never leaves the machine, and the route below answers every request
// to it from the static build on disk, so no server, port or native binary is involved.
export const ORIGIN = 'http://storybook.localhost';
export const FOUNDATIONS = 'foundations--type-and-surfaces';
export const MOBILE = { width: 390, height: 844 };

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

interface IndexEntry {
  id: string;
  type: string;
}

export function storyIds(): string[] {
  const index = join(STATIC, 'index.json');
  if (!existsSync(index)) {
    throw new Error('No static Storybook. Run pnpm --filter @drefyn/ui storybook:build first.');
  }
  const { entries } = JSON.parse(readFileSync(index, 'utf8')) as {
    entries: Record<string, IndexEntry>;
  };
  return Object.values(entries)
    .filter((entry) => entry.type === 'story')
    .map((entry) => entry.id)
    .sort();
}

export async function openStory(page: Page, id: string, theme: Theme): Promise<void> {
  await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:${theme}`);
  await expect(page.locator('#storybook-root > *').first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

function fileFor(url: URL): string | undefined {
  const path = decodeURIComponent(url.pathname);
  const file = resolve(STATIC, `.${path.endsWith('/') ? `${path}index.html` : path}`);
  if (!file.startsWith(STATIC + sep)) return undefined;
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  return file;
}

// Every test gets the static build and fails on any request to another host, so
// telemetry, web fonts or analytics added by an upgrade fail here first.
export const test = base.extend<{ outside: string[] }>({
  outside: [
    async ({ context }, use) => {
      const outside: string[] = [];
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) {
          outside.push(url.href);
          await route.abort('blockedbyclient');
          return;
        }
        const file = fileFor(url);
        if (file === undefined) await route.fulfill({ status: 404, body: '' });
        else await route.fulfill({ path: file });
      });
      await use(outside);
      expect(outside, 'requests outside the static build').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
