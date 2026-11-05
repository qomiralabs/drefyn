import { expect } from '@playwright/test';
import { uniqueAddress } from './auth-helpers.ts';
import { OPEN_ORIGIN } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

test.use({ baseURL: OPEN_ORIGIN, storageState: SIGNED_OUT });

const watch = () => {
  const log: string[] = [];
  (globalThis as unknown as { __log: string[] }).__log = log;
  const at = () => performance.now().toFixed(1);
  const note = (text: string) => log.push(`${at()} ${text}`);
  const describe = (event: Event) => {
    const target = event.target as Element | null;
    return `${event.type} ${target?.nodeName ?? ''} phase=${String(event.eventPhase)} prevented=${String(event.defaultPrevented)}`;
  };
  for (const type of ['mousedown', 'mouseup', 'click', 'submit', 'formdata']) {
    addEventListener(type, (event) => note(`cap ${describe(event)}`), true);
    addEventListener(type, (event) => note(`bub ${describe(event)}`));
  }
  for (const type of ['beforeunload', 'pagehide', 'popstate', 'securitypolicyviolation']) {
    addEventListener(type, (event) => note(`win ${event.type}`));
  }
  for (const name of ['replaceState', 'pushState'] as const) {
    const original = history[name].bind(history);
    history[name] = (...args: Parameters<typeof original>) => {
      note(`${name} ${String(args[2])}`);
      original(...args);
    };
  }
};

test('sweep', async ({ browser }) => {
  test.setTimeout(1_100_000);
  const tally: Record<string, number> = {};
  for (let round = 0; round < 4; round += 1) {
    for (let delay = 0; delay <= 400; delay += 5) {
      const context = await browser.newContext({ baseURL: OPEN_ORIGIN });
      const page = await context.newPage();
      await page.addInitScript(watch);
      const posts: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST') posts.push(request.url());
      });
      await page.goto('/sign-in', { waitUntil: 'commit' });
      await page.getByLabel('Email address').fill(uniqueAddress('diag'));
      if (delay > 0) await page.waitForTimeout(delay);
      await page.getByRole('button', { name: 'Email me a code' }).click();
      const passed = await expect(page)
        .toHaveURL(/\/sign-in\/verify/, { timeout: 2_500 })
        .then(
          () => true,
          () => false,
        );
      const key = passed ? 'ok' : 'stuck';
      tally[key] = (tally[key] ?? 0) + 1;
      if (!passed) {
        const log = await page.evaluate(() => (globalThis as unknown as { __log: string[] }).__log);
        console.log(`STUCK delay=${String(delay)} posts=${posts.join(',')}\n${log.join('\n')}`);
      }
      await context.close();
    }
  }
  console.log(`TALLY ${JSON.stringify(tally)}`);
});
