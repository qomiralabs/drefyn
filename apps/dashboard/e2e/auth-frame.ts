import { expect, type Page } from '@playwright/test';
import { AUTH_STATES } from './auth-states.ts';

// The e2e servers leave DREFYN_DOCS_URL unset, so the link carries the default.
export const DOCS_URL = 'https://docs.drefyn.com';

// The live routes that render without a sign in under way, and one gallery state of every
// screen, so each page that uses the frame is measured.
export const FRAME_PAGES: readonly string[] = [
  '/sign-in',
  '/sign-up',
  '/sign-in/password',
  '/sign-in/reset',
  '/sign-in/verify',
  ...Object.entries(AUTH_STATES).map(([screen, states]) => `/auth-states/${screen}/${states[0]}`),
];

export interface FrameBoxes {
  readonly viewport: number;
  readonly main: { readonly x: number; readonly width: number };
  readonly content: { readonly x: number; readonly width: number };
  readonly side: { readonly x: number; readonly hairline: string } | null;
}

export function frameBoxes(page: Page): Promise<FrameBoxes> {
  return page.evaluate(() => {
    const box = (element: Element | null) => {
      const rect = element?.getBoundingClientRect();
      return { x: rect?.x ?? Number.NaN, width: rect?.width ?? Number.NaN };
    };
    const side = document.querySelector('.auth-side');
    const shown = side !== null && getComputedStyle(side).display !== 'none';
    return {
      viewport: document.documentElement.clientWidth,
      main: box(document.querySelector('main')),
      content: box(document.querySelector('main .auth-content')),
      side: shown
        ? {
            x: side.getBoundingClientRect().x,
            hairline: `${getComputedStyle(side).borderInlineStartWidth} ${getComputedStyle(side).borderInlineStartStyle}`,
          }
        : null,
    };
  });
}

// The form panel starts at the inline start edge at two fifths of the width, within one
// percent, and the side panel begins at its end with a one pixel rule.
export function expectSplit(boxes: FrameBoxes, where: string): void {
  const { viewport, main, side } = boxes;
  expect(main.x, where).toBe(0);
  expect(Math.abs(main.width - viewport * 0.4), where).toBeLessThanOrEqual(viewport * 0.01);
  expect(side, where).not.toBeNull();
  expect(Math.abs((side?.x ?? 0) - (main.x + main.width)), where).toBeLessThanOrEqual(0.5);
  expect(side?.hairline, where).toBe('1px solid');
}

export const docsLink = (page: Page) =>
  page.getByRole('banner').getByRole('link', { name: 'Documentation' });

// The docs site is not part of the stack, so its page is answered here and nothing leaves.
export async function answerDocs(page: Page): Promise<void> {
  await page.route(
    (url) => url.origin === DOCS_URL,
    (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Drefyn docs</title><h1>Docs</h1>' }),
  );
}
