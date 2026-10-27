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

export interface IndexEntry {
  id: string;
  type: 'story' | 'docs';
}

export const INDEX = join(STATIC, 'index.json');

// Every page the build lists, stories and docs, in a stable order.
export function indexEntries(): IndexEntry[] {
  if (!existsSync(INDEX)) {
    throw new Error('No static Storybook. Run pnpm --filter @drefyn/ui storybook:build first.');
  }
  const { entries } = JSON.parse(readFileSync(INDEX, 'utf8')) as {
    entries: Record<string, { id: string; type: string }>;
  };
  return Object.values(entries)
    .filter((entry): entry is IndexEntry => entry.type === 'story' || entry.type === 'docs')
    .map(({ id, type }) => ({ id, type }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

export const storyIds = (): string[] =>
  indexEntries()
    .filter((entry) => entry.type === 'story')
    .map((entry) => entry.id);
export const docsIds = (): string[] =>
  indexEntries()
    .filter((entry) => entry.type === 'docs')
    .map((entry) => entry.id);

// Story ids carrying a tag, such as 'disabled' for stories that show a disabled control.
export function storiesTagged(tag: string): string[] {
  if (!existsSync(INDEX)) {
    throw new Error('No static Storybook. Run pnpm --filter @drefyn/ui storybook:build first.');
  }
  const { entries } = JSON.parse(readFileSync(INDEX, 'utf8')) as {
    entries: Record<string, { id: string; type: string; tags?: string[] }>;
  };
  return Object.values(entries)
    .filter((entry) => entry.type === 'story' && (entry.tags ?? []).includes(tag))
    .map((entry) => entry.id)
    .sort();
}

export const rgb = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

// Safari moves focus to links and buttons only with Option held, unless the user changed it.
export const tabKey = (browserName: string): string =>
  browserName === 'webkit' ? 'Alt+Tab' : 'Tab';

// A test that opens every story gets this much time per page on top of the default, so the
// budget grows with the build instead of failing when a story is added. Measured under
// amd64 emulation on Apple Silicon, the slowest place these run.
export const PAGE_BUDGET_MS = 2_000;
export const sweepTimeout = (pages: number): number => 30_000 + pages * PAGE_BUDGET_MS;

// Firefox lays out in sixtieths of a pixel and reports a width as right minus left in
// floating point, so two equal boxes can differ in the fifth decimal depending on where they
// sit. A hundredth of a pixel is far below anything visible.
export const SAME_SIZE_PX = 0.01;
export const sameSize = (
  a: { width: number; height: number } | null,
  b: { width: number; height: number } | null,
): boolean =>
  a !== null &&
  b !== null &&
  Math.abs(a.width - b.width) < SAME_SIZE_PX &&
  Math.abs(a.height - b.height) < SAME_SIZE_PX;

export async function openPage(page: Page, entry: IndexEntry, theme: Theme): Promise<void> {
  const mode = entry.type === 'docs' ? 'docs' : 'story';
  await page.goto(`/iframe.html?id=${entry.id}&viewMode=${mode}&globals=theme:${theme}`);
  const root = entry.type === 'docs' ? '#storybook-docs .sbdocs-wrapper' : '#storybook-root > *';
  await expect(page.locator(root).first()).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

export const openStory = (page: Page, id: string, theme: Theme): Promise<void> =>
  openPage(page, { id, type: 'story' }, theme);

function fileFor(url: URL): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    // A malformed escape is a missing file, not a request left hanging.
    return undefined;
  }
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
        if (file === undefined)
          await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
        else await route.fulfill({ path: file });
      });
      await use(outside);
      expect(outside, 'requests outside the static build').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

// Toasts close on a timer, so a screenshot of one would race it. The pointer over the
// notifications holds every timer; the toasts draw no hover state, so nothing else changes.
export async function holdToasts(page: Page): Promise<void> {
  const notifications = page.getByRole('region', { name: /notification/i });
  await expect(notifications).toBeVisible();
  await notifications.hover({ position: { x: 1, y: 1 } });
}
