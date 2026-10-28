import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type Page, type Request } from '@playwright/test';

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
  // The component title, which a docs page shares with its stories.
  title: string;
}

export const INDEX = join(STATIC, 'index.json');

// Every page the build lists, stories and docs, in a stable order.
export function indexEntries(): IndexEntry[] {
  if (!existsSync(INDEX)) {
    throw new Error('No static Storybook. Run pnpm --filter @drefyn/ui storybook:build first.');
  }
  const { entries } = JSON.parse(readFileSync(INDEX, 'utf8')) as {
    entries: Record<string, { id: string; type: string; title: string }>;
  };
  return Object.values(entries)
    .filter((entry): entry is IndexEntry => entry.type === 'story' || entry.type === 'docs')
    .map(({ id, type, title }) => ({ id, type, title }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

// A docs page as the build lists it, so the ready signal knows its title.
export function docsEntry(id: string): IndexEntry {
  const entry = indexEntries().find((e) => e.id === id && e.type === 'docs');
  if (entry === undefined) throw new Error(`no docs page ${id} in the build`);
  return entry;
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

// The manager loads its own bundles before it starts the preview iframe, so a story in it
// appears seconds after one opened alone. Under amd64 emulation that has taken over 5 s,
// the default wait for an assertion.
export const MANAGER_READY_MS = 15_000;

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

// Stories on a docs page with the same title, which is how many story blocks it must show.
export function storiesOnDocsPage(title: string): number {
  return indexEntries().filter((entry) => entry.type === 'story' && entry.title === title).length;
}

export const DOCS_READY_CEILING_MS = 20_000;

export interface DocsReadiness {
  ready: boolean;
  anchors: number;
  emptyRoots: number;
  heights: [number, number];
}

// Storybook shows the docs wrapper first and mounts each story into its block afterwards, so a
// visible wrapper is not a finished page. Ready means every story block exists and has content,
// the fonts are in, and the page height holds across two animation frames.
export async function docsReadiness(
  page: Page,
  stories: number,
  ceiling = DOCS_READY_CEILING_MS,
): Promise<DocsReadiness> {
  return page.evaluate(
    async ({ stories: wanted, ceiling: limit }) => {
      const frame = () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      const started = performance.now();
      await document.fonts.ready;
      for (;;) {
        const anchors = document.querySelectorAll('#storybook-docs [id^="anchor--"]').length;
        // Each block's .sb-story always holds a wrapper; the story itself mounts into the
        // story--<id>-inner element, which stays empty until it renders.
        const emptyRoots = [
          ...document.querySelectorAll('#storybook-docs [id^="story--"][id$="-inner"]'),
        ].filter((el) => el.childElementCount === 0).length;
        const before = document.documentElement.scrollHeight;
        await frame();
        const after = document.documentElement.scrollHeight;
        const heights: [number, number] = [before, after];
        if (anchors >= wanted && emptyRoots === 0 && before === after) {
          return { ready: true, anchors, emptyRoots, heights };
        }
        if (performance.now() - started > limit) {
          return { ready: false, anchors, emptyRoots, heights };
        }
        await frame();
      }
    },
    { stories, ceiling },
  );
}

export async function openPage(page: Page, entry: IndexEntry, theme: Theme): Promise<void> {
  const mode = entry.type === 'docs' ? 'docs' : 'story';
  await page.goto(`/iframe.html?id=${entry.id}&viewMode=${mode}&globals=theme:${theme}`);
  const root = entry.type === 'docs' ? '#storybook-docs .sbdocs-wrapper' : '#storybook-root > *';
  // A docs page loads every story's module before its wrapper shows, so it gets the same
  // ceiling as the ready signal.
  await expect(page.locator(root).first()).toBeVisible(
    entry.type === 'docs' ? { timeout: DOCS_READY_CEILING_MS } : {},
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  if (entry.type === 'docs') {
    const stories = storiesOnDocsPage(entry.title);
    const state = await docsReadiness(page, stories);
    if (!state.ready) {
      throw new Error(
        `${entry.id} was not ready after ${DOCS_READY_CEILING_MS} ms: ${state.anchors} of ${stories} story anchors, ${state.emptyRoots} empty story roots, last heights ${state.heights.join(' and ')}`,
      );
    }
    return;
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

export const openStory = (page: Page, id: string, theme: Theme): Promise<void> =>
  openPage(page, { id, type: 'story', title: '' }, theme);

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
// telemetry, web fonts or analytics added by an upgrade fail here first. `drained` waits
// until every request a page has started has finished or failed, so one still on its way
// is seen by the outside check below. It counts Playwright's own request events instead
// of waiting for the network idle load state, which Firefox under emulation sometimes
// never reports on a page with nothing left to load.
export const test = base.extend<{ outside: string[]; drained: () => Promise<void> }>({
  // Named provide, not use, so the React hooks lint rule does not take it for a hook.
  drained: async ({ context }, provide) => {
    const inFlight = new Set<Request>();
    const done = (request: Request) => inFlight.delete(request);
    context.on('request', (request) => inFlight.add(request));
    context.on('requestfinished', done);
    context.on('requestfailed', done);
    await provide(async () => {
      await expect
        .poll(() => [...inFlight].map((request) => request.url()), {
          message: 'requests still in flight',
        })
        .toEqual([]);
    });
  },
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
