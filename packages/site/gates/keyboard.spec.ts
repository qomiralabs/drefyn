import { expect, test } from '@playwright/test';
import { open, PAGES } from './fixtures.ts';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';

interface Stop {
  index: number;
  ring: boolean;
  onScreen: boolean;
}

for (const target of PAGES) {
  test(`${target.id} tabs through every control in order with a visible ring`, async ({
    page,
    browserName,
  }) => {
    await open(page, target, 'light', 'desktop');
    const count = await page.locator(FOCUSABLE).evaluateAll((els) => {
      els.forEach((el, i) => {
        el.setAttribute('data-gate-stop', String(i));
      });
      return els.length;
    });
    expect(count, 'a page with nothing to reach proves nothing').toBeGreaterThan(0);
    // Safari moves to links only on Option Tab, as a reader with default settings would.
    const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    const stops: Stop[] = [];
    for (let i = 0; i < count; i += 1) {
      await page.keyboard.press(tab);
      stops.push(
        await page.evaluate(() => {
          const el = document.activeElement;
          if (!(el instanceof HTMLElement)) return { index: -1, ring: false, onScreen: false };
          const style = getComputedStyle(el);
          const outline =
            style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
          const rect = el.getBoundingClientRect();
          return {
            index: Number(el.dataset['gateStop'] ?? -1),
            ring: outline || style.boxShadow !== 'none',
            onScreen:
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > 0 &&
              rect.right > 0 &&
              rect.top < innerHeight &&
              rect.left < innerWidth,
          };
        }),
      );
    }
    expect(stops.map((s) => s.index)).toEqual([...Array(count).keys()]);
    expect(
      stops.filter((s) => !s.ring).map((s) => s.index),
      'no visible focus ring',
    ).toEqual([]);
    expect(
      stops.filter((s) => !s.onScreen).map((s) => s.index),
      'focus off screen',
    ).toEqual([]);
  });
}
