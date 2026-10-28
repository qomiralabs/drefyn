import { expect, type APIRequestContext, type Page } from '@playwright/test';

// Words only the placeholder organization's pages say. None may reach a 404, in the HTML,
// in the streamed page data or in the title the client sets afterwards.
export const FIXTURE_WORDS = [
  'Acme',
  'Maya Okafor',
  'Payments API',
  'Partner API',
  'Pending docs',
  'Starter',
  'need you',
  'out of date',
  'req_8f2a91',
  'Plan and usage',
  'seats used',
] as const;

// Every placeholder route, under the real organization and under one that does not exist.
export const LEAK_PATHS = [
  '/acme',
  '/acme/docs',
  '/acme/status',
  '/acme/studio',
  '/acme/docs/payments-api',
  '/acme/docs/new-docs',
  '/acme/docs/unreachable',
  '/acme/docs/pending',
  '/acme/docs/payments-api/pages',
  '/acme/settings',
  '/acme/settings/plan',
  '/acme/settings/members',
] as const;

export const UNKNOWN_ORG_PATHS = [
  '/nope',
  '/ACME',
  '/zzz/docs',
  '/zzz/docs/payments-api',
  '/zzz/docs/payments-api/pages',
  '/zzz/docs/pending',
  '/zzz/settings',
  '/zzz/settings/plan',
] as const;

export async function expectBodyLeaksNothing(
  request: APIRequestContext,
  path: string,
): Promise<void> {
  const res = await request.get(path, { maxRedirects: 0 });
  expect(res.status(), path).toBe(404);
  const body = await res.text();
  expect(
    FIXTURE_WORDS.filter((word) => body.includes(word)),
    path,
  ).toEqual([]);
}

export async function expectTitleLeaksNothing(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
  const title = await page.title();
  expect(
    FIXTURE_WORDS.filter((word) => title.includes(word)),
    `${path}: ${title}`,
  ).toEqual([]);
  expect(title, path).toMatch(/^Not found/);
}
