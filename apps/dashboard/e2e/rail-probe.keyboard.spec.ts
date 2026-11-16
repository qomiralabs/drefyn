import { expect } from '@playwright/test';
import { test } from './csp.ts';
import { ROUTES, TABLET } from './fixtures.ts';

// A temporary probe for #543: the focus and key order around F6, F6, Tab on the tablet rail.
test('probe the rail focus order', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'chromium is where it failed');
  test.setTimeout(600_000);
  await page.setViewportSize(TABLET);
  await page.addInitScript(() => {
    const w = window as unknown as { log: string[] };
    w.log = [];
    const t0 = performance.now();
    const at = () => Math.round(performance.now() - t0);
    const d = (el: EventTarget | null) =>
      el instanceof Element
        ? `${el.tagName}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''}${el.getAttribute('aria-label') ? `"${el.getAttribute('aria-label')?.slice(0, 20)}"` : ''}${el.getAttribute('href') ? `(${el.getAttribute('href')})` : ''}${el.isConnected ? '' : '(gone)'}`
        : el === null
          ? 'null'
          : 'window';
    window.addEventListener(
      'keydown',
      (e) => {
        w.log.push(`${at()} key ${e.key} active=${d(document.activeElement)}`);
      },
      true,
    );
    document.addEventListener(
      'focusin',
      (e) => {
        w.log.push(`${at()} focusin ${d(e.target)}`);
      },
      true,
    );
    document.addEventListener(
      'focusout',
      (e) => {
        w.log.push(`${at()} focusout ${d(e.target)} related=${d(e.relatedTarget)}`);
      },
      true,
    );
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.removedNodes) {
          if (
            n instanceof Element &&
            (n.matches('a[href]') || n.querySelector('a[href]')) &&
            r.target instanceof Element &&
            r.target.closest('nav') !== null
          )
            w.log.push(`${at()} removed link in nav active=${d(document.activeElement)}`);
        }
        for (const n of r.addedNodes) {
          if (
            n instanceof Element &&
            (n.matches('[role=tooltip]') || n.querySelector('[role=tooltip]'))
          )
            w.log.push(`${at()} tooltip added`);
        }
      }
    }).observe(document, { childList: true, subtree: true });
    document.addEventListener('readystatechange', () => {
      w.log.push(`${at()} ready ${document.readyState}`);
    });
  });
  const failures: string[] = [];
  for (let run = 0; run < 60; run += 1) {
    await page.goto(ROUTES.project);
    await expect(page.locator('html')).toHaveAttribute('data-shell', 'ready');
    await page.evaluate(() => {
      (window as unknown as { log: string[] }).log.push('--- shell ready');
    });
    await page.keyboard.press('F6');
    await page.keyboard.press('F6');
    await page.keyboard.press('Tab');
    const first = page
      .getByRole('navigation', { name: 'Payments API docs' })
      .getByRole('link')
      .first();
    const ok = await first.evaluate((el) => el === document.activeElement).catch(() => false);
    const tip = await page
      .locator('[role="tooltip"]')
      .waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    const focusedLater = await first
      .evaluate((el) => el === document.activeElement)
      .catch(() => false);
    if (!ok || !tip || !focusedLater) {
      const log = await page.evaluate(() => (window as unknown as { log: string[] }).log);
      failures.push(
        `run ${String(run)} focusedAtOnce=${String(ok)} tip=${String(tip)} focusedLater=${String(focusedLater)}\n${log.join('\n')}`,
      );
    }
  }
  console.log(`PROBE ${String(failures.length)} of 60\n${failures.join('\n=====\n')}`);
  expect(failures).toEqual([]);
});
