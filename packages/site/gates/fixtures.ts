import type { Page } from '@playwright/test';
import { breachFrom, buildGateSet, ORIGIN, type GatePage } from './pages.ts';

export { ORIGIN, type GatePage };

export const SET = buildGateSet(breachFrom(process.env));
export const PAGES = SET.pages;

export const THEMES = ['light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const WIDTHS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 },
} as const;
export type Width = keyof typeof WIDTHS;

export const url = (page: GatePage) => `${ORIGIN}${page.path}`;

// The system colour scheme picks the theme, so the same call works with scripts off, where
// no stored choice can be read.
export async function open(
  page: Page,
  target: GatePage,
  theme: Theme,
  width: Width,
  { scripts = true }: { scripts?: boolean } = {},
) {
  await page.setViewportSize(WIDTHS[width]);
  await page.emulateMedia({ colorScheme: theme });
  const response = await page.goto(url(target));
  if (response?.status() !== 200) {
    throw new Error(`${target.path} answered ${String(response?.status())}`);
  }
  // Docs pages swap in web fonts; a check before they settle reads the fallback. With
  // scripts off there is no page script to ask, and Firefox never answers one.
  if (scripts) await page.evaluate(() => document.fonts.ready.then(() => undefined));
}
