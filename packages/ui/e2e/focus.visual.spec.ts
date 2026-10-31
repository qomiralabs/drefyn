import { currentPlace, insidePinnedImage } from '../scripts/in-container.ts';
import { expect, MOBILE, openStory, test, type Theme } from './fixtures.ts';

const VARIANTS: { name: string; theme: Theme; mobile: boolean }[] = [
  { name: 'light', theme: 'light', mobile: false },
  { name: 'dark', theme: 'dark', mobile: false },
  { name: 'light-390', theme: 'light', mobile: true },
];

// The ring only shows on keyboard focus, which a plain story screenshot never has. Each
// case presses keys until the named control has focus, then compares the page. The ring
// is drawn the same way in every engine, so Chromium in the pinned image stands for all.
// What the focused element is: its role attribute, or its tag when the role is native.
type Focused = 'button' | 'a' | 'switch' | 'menuitem' | 'input';

const CASES: { id: string; keys: string[]; focused: Focused }[] = [
  { id: 'components-button--primary', keys: ['Tab'], focused: 'button' },
  { id: 'components-button--disabled', keys: ['Tab'], focused: 'button' },
  { id: 'components-button--busy', keys: ['Tab'], focused: 'button' },
  { id: 'components-button--links', keys: ['Tab'], focused: 'a' },
  { id: 'components-switch--off', keys: ['Tab'], focused: 'switch' },
  { id: 'components-switch--disabled', keys: ['Tab'], focused: 'switch' },
  { id: 'components-menu--default', keys: ['Tab'], focused: 'button' },
  { id: 'components-menu--default', keys: ['Tab', 'Enter', 'ArrowDown'], focused: 'menuitem' },
  {
    id: 'components-menu--default',
    keys: ['Tab', 'Enter', 'ArrowDown', 'ArrowDown'],
    focused: 'menuitem',
  },
  // The tooltip shows on keyboard focus, so the ring and the tooltip are one screenshot.
  { id: 'components-tooltip--toolbar', keys: ['Tab', 'Tab'], focused: 'button' },
  { id: 'components-tooltip--disabled-reason', keys: ['Escape', 'Tab'], focused: 'button' },
  { id: 'components-text-field--default', keys: ['Tab'], focused: 'input' },
  { id: 'components-text-field--invalid', keys: ['Tab'], focused: 'input' },
  { id: 'components-text-field--disabled', keys: ['Tab'], focused: 'input' },
  { id: 'components-dialog--default', keys: ['Tab', 'Enter'], focused: 'input' },
  { id: 'components-dialog--open', keys: ['Tab', 'Tab', 'Tab', 'Tab'], focused: 'button' },
  // F6 reaches the notifications, Tab the toast, Tab again Undo. Focus inside holds the timer.
  { id: 'components-toast--undo', keys: ['F6', 'Tab', 'Tab'], focused: 'button' },
];

test.beforeAll(() => {
  if (!insidePinnedImage(currentPlace())) {
    throw new Error('Screenshots are compared only inside the pinned image. Run test:visual.');
  }
});

for (const { id, keys, focused } of CASES) {
  const name = `${id}-focus-${keys.length}`;
  for (const variant of VARIANTS) {
    test(`${id} after ${keys.join(' ')} looks the same in ${variant.name}`, async ({ page }) => {
      if (variant.mobile) await page.setViewportSize(MOBILE);
      await openStory(page, id, variant.theme);
      for (const key of keys) await page.keyboard.press(key);
      await expect(page.locator(':focus')).toHaveCount(1);
      const active = await page.evaluate(() => {
        const el = document.activeElement;
        return el?.getAttribute('role') ?? el?.tagName.toLowerCase() ?? '';
      });
      expect(active).toBe(focused);
      await expect(page).toHaveScreenshot(`${name}-${variant.name}.png`, { fullPage: true });
    });
  }
}
