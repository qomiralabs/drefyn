import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { sql, uniqueAddress } from './auth-helpers.ts';
import { ON_ORIGIN } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

test.use({ storageState: SIGNED_OUT });

const FORMS = [
  { path: '/sign-in', button: 'Email me a code' },
  { path: '/sign-in/password', button: 'Sign in' },
  { path: '/sign-in/reset', button: 'Email me a code' },
] as const;

interface Captured {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

// A real post from the real page, held back so each case can replay it with one thing wrong.
async function capture(page: Page, path: string, button: string): Promise<Captured> {
  await page.goto(path);
  await page.getByLabel('Email address').fill(uniqueAddress('csrf'));
  const secret = page.getByLabel('Password', { exact: true });
  if ((await secret.count()) > 0) await secret.fill('a wrong password of some length');
  let held: Captured | undefined;
  await page.route(`**${path}`, async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && held === undefined) {
      held = {
        url: request.url(),
        headers: await request.allHeaders(),
        body: request.postDataBuffer() ?? Buffer.alloc(0),
      };
    }
    await route.abort();
  });
  await page.getByRole('button', { name: button, exact: true }).click();
  await expect.poll(() => held !== undefined).toBe(true);
  if (held === undefined) throw new Error('the form did not post');
  return held;
}

function without(headers: Record<string, string>, ...names: readonly string[]) {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !names.includes(k)));
}

const counts = async () => ({
  sessions: await sql('select count(*) from app.sessions'),
  limits: await sql('select coalesce(sum(count), 0) from app.auth_rate_limits'),
});

const post = (request: APIRequestContext, held: Captured, headers: Record<string, string>) =>
  request.post(held.url, { headers, data: held.body, maxRedirects: 0 });

for (const { path, button } of FORMS) {
  test.describe(path, () => {
    test('refuses a second origin', async ({ page, playwright }) => {
      const held = await capture(page, path, button);
      const request = await playwright.request.newContext();
      const before = await counts();
      await post(request, held, { ...held.headers, origin: 'https://evil.example' });
      expect(await counts()).toEqual(before);
      await request.dispose();
    });

    test('refuses no Origin', async ({ page, playwright }) => {
      const held = await capture(page, path, button);
      const request = await playwright.request.newContext();
      const before = await counts();
      await post(request, held, without(held.headers, 'origin'));
      expect(await counts()).toEqual(before);
      await request.dispose();
    });

    test('refuses a post with no pre cookie', async ({ page, playwright }) => {
      const held = await capture(page, path, button);
      const request = await playwright.request.newContext();
      const before = await counts();
      await post(request, held, { ...without(held.headers, 'cookie'), origin: ON_ORIGIN });
      expect(await counts()).toEqual(before);
      await request.dispose();
    });

    test('refuses a forged field', async ({ page, playwright }) => {
      const held = await capture(page, path, button);
      const forged = Buffer.from(
        held.body.toString('latin1').replace(/[A-Za-z0-9_-]{43}/, 'A'.repeat(43)),
        'latin1',
      );
      const request = await playwright.request.newContext();
      const before = await counts();
      await post(request, { ...held, body: forged }, held.headers);
      expect(await counts()).toEqual(before);
      await request.dispose();
    });
  });
}
