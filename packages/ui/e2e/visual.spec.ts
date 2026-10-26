import { currentPlace, insidePinnedImage } from '../scripts/in-container.ts';
import { expect, indexEntries, MOBILE, openPage, test, type Theme } from './fixtures.ts';

const VARIANTS: { name: string; theme: Theme; mobile: boolean }[] = [
  { name: 'light', theme: 'light', mobile: false },
  { name: 'dark', theme: 'dark', mobile: false },
  { name: 'light-390', theme: 'light', mobile: true },
];

// Font rendering differs between machines, so a baseline is only made or compared in the
// pinned image. The runner script starts it; this stops a direct call on a host.
test.beforeAll(() => {
  if (!insidePinnedImage(currentPlace())) {
    throw new Error('Screenshots are compared only inside the pinned image. Run test:visual.');
  }
});

// Stories and docs pages both, since docs pages are what readers of the published
// Storybook see first.
for (const entry of indexEntries()) {
  for (const variant of VARIANTS) {
    test(`${entry.type} ${entry.id} looks the same in ${variant.name}`, async ({ page }) => {
      if (variant.mobile) await page.setViewportSize(MOBILE);
      await openPage(page, entry, variant.theme);
      await expect(page).toHaveScreenshot(`${entry.id}-${variant.name}.png`, { fullPage: true });
    });
  }
}
