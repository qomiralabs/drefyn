import { expect, type Locator, type Page } from '@playwright/test';

export const ON_PORT = 3100;
export const OFF_PORT = 3101;
export const ON_ORIGIN = `http://127.0.0.1:${ON_PORT}`;
export const OFF_ORIGIN = `http://127.0.0.1:${OFF_PORT}`;

export const MOBILE = { width: 390, height: 844 };
export const TABLET = { width: 834, height: 1112 };
export const DESKTOP = { width: 1440, height: 900 };

export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

// The placeholder routes. Each project slug is one state of the project home.
export const ROUTES = {
  overview: '/acme',
  project: '/acme/docs/payments-api',
  empty: '/acme/docs/new-docs',
  error: '/acme/docs/unreachable',
  loading: '/acme/docs/pending',
} as const;

// What needs the person on the overview. The inbox count, the overview sentence and the
// Needs you list all say this number.
export const NEEDS_YOU = 2;

export const ANSWERS = {
  overview: 'Two things need you. Everything else is fresh and running.',
  project: '3 pages are out of date. The other 47 match your API.',
  empty: 'No pages yet. Generate them from your repository, or write the first one.',
  error:
    'We could not load this project. Your docs site is still online; only the dashboard is affected.',
} as const;

// Safari moves focus to links and buttons only with Option held, unless the user changed it.
export const tabKey = (browserName: string): string =>
  browserName === 'webkit' ? 'Alt+Tab' : 'Tab';

// The stored choice the head script reads, set before any page script runs.
export async function useTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('dr-theme', value);
  }, theme);
  await page.emulateMedia({ colorScheme: theme });
}

// Waits for the client to take over, so keyboard handlers are attached before a key press.
export async function openShell(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
}

export const banner = (page: Page): Locator => page.getByRole('banner');
export const products = (page: Page): Locator =>
  banner(page).getByRole('navigation', { name: 'Products', exact: true });
export const main = (page: Page): Locator => page.getByRole('main');
export const commandBar = (page: Page): Locator =>
  page.getByRole('dialog', { name: 'Search or run a command' });

// A text field dropped into main, standing in for any field a product page will have.
export async function addField(page: Page): Promise<Locator> {
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.setAttribute('aria-label', 'Stand in field');
    document.getElementById('main')?.prepend(input);
  });
  return page.getByRole('textbox', { name: 'Stand in field' });
}

// Describes the focused element by tag and name, so a failure says where focus went. Ids are
// left out: React Aria gives its triggers generated ids that change between builds.
export async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return 'body';
    const name = el.getAttribute('aria-label') ?? el.textContent.trim().replace(/\s+/g, ' ');
    return `${el.tagName.toLowerCase()} ${name}`.trim();
  });
}

// The landmark that holds focus: banner, the sidebar navigation, main, or none.
export async function focusedRegion(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return 'none';
    if (el.closest('header') !== null) return 'banner';
    if (el.closest('main') !== null) return 'main';
    const nav = el.closest('nav[aria-label]');
    if (nav !== null && nav.closest('header') === null)
      return `nav ${nav.getAttribute('aria-label') ?? ''}`;
    return 'none';
  });
}
