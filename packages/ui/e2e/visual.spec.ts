import { IMAGE, MARKER } from '../scripts/in-container.ts';
import { expect, MOBILE, openStory, storyIds, test, type Theme } from './fixtures.ts';

const VARIANTS: { name: string; theme: Theme; mobile: boolean }[] = [
  { name: 'light', theme: 'light', mobile: false },
  { name: 'dark', theme: 'dark', mobile: false },
  { name: 'light-390', theme: 'light', mobile: true },
];

// Font rendering differs between machines, so a baseline is only made or compared in the
// pinned image. The runner script starts it; this stops a direct call on a host.
test.beforeAll(() => {
  if (process.env[MARKER] !== IMAGE) {
    throw new Error('Screenshots are compared only inside the pinned image. Run test:visual.');
  }
});

for (const id of storyIds()) {
  for (const variant of VARIANTS) {
    test(`${id} looks the same in ${variant.name}`, async ({ page }) => {
      if (variant.mobile) await page.setViewportSize(MOBILE);
      await openStory(page, id, variant.theme);
      await expect(page).toHaveScreenshot(`${id}-${variant.name}.png`, { fullPage: true });
    });
  }
}
