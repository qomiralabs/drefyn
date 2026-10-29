import type { Page } from '@playwright/test';
import { docsReadiness, expect, ORIGIN, test, waitForDocs } from './fixtures.ts';

// Each fixture page holds the docs ready wait on exactly one condition, so dropping that
// condition from docsReadiness makes its case pass when it must not.
const SHORT_MS = 600;

function docsPage(blocks: string, script = ''): string {
  return `<!doctype html><html lang="en"><head><title>Docs</title></head><body><div id="storybook-docs"><div class="sbdocs-wrapper">${blocks}</div></div><script>${script}</script></body></html>`;
}

// One story block as Storybook writes it: an anchor, and a story root inside .sb-story.
const block = (id: string, filled: boolean) =>
  `<div id="anchor--${id}"><div class="sb-story"><div id="story--${id}-inner">${filled ? '<p>Story</p>' : ''}</div></div></div>`;

const FULL = block('a', true) + block('b', true);

async function serve(page: Page, html: string, init?: () => void): Promise<void> {
  if (init !== undefined) await page.addInitScript(init);
  await page.route(`${ORIGIN}/docs-case.html`, (route) =>
    route.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.goto('/docs-case.html');
}

test('a finished page is ready', async ({ page }) => {
  await serve(page, docsPage(FULL));
  const state = await docsReadiness(page, 2, SHORT_MS);
  expect(state).toMatchObject({ ready: true, anchors: 2, innerRoots: 2, emptyRoots: 0 });
});

test('a page with fewer story anchors than stories is not ready', async ({ page }) => {
  await serve(page, docsPage(FULL));
  const state = await docsReadiness(page, 3, SHORT_MS);
  expect(state).toMatchObject({ ready: false, anchors: 2 });
});

test('a page whose story roots carry other ids is not ready', async ({ page }) => {
  const renamed = FULL.replaceAll('-inner"', '-body"');
  await serve(page, docsPage(renamed));
  const state = await docsReadiness(page, 2, SHORT_MS);
  expect(state).toMatchObject({ ready: false, anchors: 2, innerRoots: 0 });
});

test('a page with an empty story root is not ready', async ({ page }) => {
  await serve(page, docsPage(block('a', true) + block('b', false)));
  const state = await docsReadiness(page, 2, SHORT_MS);
  expect(state).toMatchObject({ ready: false, innerRoots: 2, emptyRoots: 1 });
});

test('a page whose height is still changing is not ready', async ({ page }) => {
  // A block that grows every frame, as a story that is still laying out does.
  const grow =
    "const g=document.createElement('div');document.body.append(g);let h=1;(function f(){h+=1;g.style.height=h+'px';requestAnimationFrame(f);})();";
  await serve(page, docsPage(FULL, grow));
  const state = await docsReadiness(page, 2, SHORT_MS);
  expect(state.ready).toBe(false);
  expect(state.heights[0]).not.toBe(state.heights[1]);
});

test('a page whose fonts never finish loading is not ready', async ({ page }) => {
  await serve(page, docsPage(FULL), () => {
    Object.defineProperty(document.fonts, 'ready', {
      configurable: true,
      get: () => new Promise(() => undefined),
    });
  });
  const state = await docsReadiness(page, 2, SHORT_MS);
  expect(state.ready).toBe(false);
});

test('the wait names every count when it gives up', async ({ page }) => {
  await serve(page, docsPage(block('a', true) + block('b', false)));
  await expect(waitForDocs(page, 'components-case--docs', 3, SHORT_MS)).rejects.toThrow(
    /^components-case--docs was not ready after 600 ms: 2 of 3 story anchors, 2 of 3 story roots, 1 empty story roots, last heights \d+ and \d+$/,
  );
});
