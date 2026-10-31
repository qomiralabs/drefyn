import { currentPlace, insidePinnedImage } from '../scripts/in-container.ts';
import { expect, MOBILE, openStory, test, type Theme } from './fixtures.ts';

const VARIANTS: { name: string; theme: Theme; mobile: boolean }[] = [
  { name: 'light', theme: 'light', mobile: false },
  { name: 'dark', theme: 'dark', mobile: false },
  { name: 'light-390', theme: 'light', mobile: true },
];

// A hover fill shows only under a pointer, which a plain story screenshot never has. The
// round trigger's fill must follow its circle, so its hover is compared on its own.
const CASES = [{ id: 'components-menu--round-trigger', name: /^MO, account for/ }];

test.beforeAll(() => {
  if (!insidePinnedImage(currentPlace())) {
    throw new Error('Screenshots are compared only inside the pinned image. Run test:visual.');
  }
});

for (const { id, name } of CASES) {
  for (const variant of VARIANTS) {
    test(`${id} hovered looks the same in ${variant.name}`, async ({ page }) => {
      if (variant.mobile) await page.setViewportSize(MOBILE);
      await openStory(page, id, variant.theme);
      const trigger = page.getByRole('button', { name });
      await trigger.hover();
      await expect(trigger).toHaveCSS('border-top-left-radius', '9999px');
      await expect(page).toHaveScreenshot(`${id}-hover-${variant.name}.png`, { fullPage: true });
    });
  }
}
