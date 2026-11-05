import { test as base, type APIResponse, type Response } from '@playwright/test';
import { absoluteLinkProblems, locationProblem } from './location-check.ts';

const OURS = /^http:\/\/127\.0\.0\.1:310[0145]$/;

export function responseProblems(
  url: string,
  location: string | undefined,
  html: string | undefined,
): readonly string[] {
  const { origin } = new URL(url);
  if (!OURS.test(origin)) return [];
  const moved = location === undefined ? null : locationProblem(location, origin);
  return [...(moved === null ? [] : [moved]), ...absoluteLinkProblems(html ?? '', origin)];
}

async function browserHtml(response: Response): Promise<string | undefined> {
  if (response.request().resourceType() !== 'document') return undefined;
  if (response.status() >= 300 && response.status() < 400) return undefined;
  return response.text().catch(() => undefined);
}

async function requestHtml(response: APIResponse): Promise<string | undefined> {
  const type = response.headers()['content-type'] ?? '';
  return type.includes('text/html') ? response.text() : undefined;
}

// Every spec imports this test, so the check runs over the whole suite: each Location header
// and each absolute link in returned HTML must be relative or on the configured origin.
export const test = base.extend<{ urlProblems: string[]; urlWatch: undefined }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright reads the fixture's arguments
  urlProblems: async ({}, provide) => {
    await provide([]);
  },
  urlWatch: [
    async ({ page, urlProblems }, use) => {
      const pending: Promise<void>[] = [];
      page.on('response', (response) => {
        pending.push(
          browserHtml(response).then((html) => {
            urlProblems.push(
              ...responseProblems(response.url(), response.headers()['location'], html),
            );
          }),
        );
      });
      await use(undefined);
      await Promise.allSettled(pending);
      if (urlProblems.length > 0) {
        throw new Error(`left the configured origin: ${urlProblems.join(', ')}`);
      }
    },
    { auto: true },
  ],
  request: async ({ request, urlProblems }, provide) => {
    const get = request.get.bind(request);
    const watched = async (...args: Parameters<typeof get>) => {
      const response = await get(...args);
      urlProblems.push(
        ...responseProblems(
          response.url(),
          response.headers()['location'],
          await requestHtml(response),
        ),
      );
      return response;
    };
    request.get = watched as typeof request.get;
    await provide(request);
  },
});
