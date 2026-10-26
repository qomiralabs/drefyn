import { tokens } from '../src/index.ts';
import { expect, FOUNDATIONS, openStory, test, THEMES } from './fixtures.ts';

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

for (const theme of THEMES) {
  test(`${theme} sets data-theme on html and paints the token colours`, async ({ page }) => {
    await openStory(page, FOUNDATIONS, theme);
    const colours = await page.evaluate(() => {
      const ground = getComputedStyle(document.documentElement).backgroundColor;
      const heading = document.querySelector('h1');
      return { ground, ink: heading ? getComputedStyle(heading).color : '' };
    });
    expect(colours).toEqual({
      ground: rgb(tokens.color.surface.ground[theme]),
      ink: rgb(tokens.color.text.ink[theme]),
    });
  });
}

test('Inter loads from the bundled fonts', async ({ page }) => {
  await openStory(page, FOUNDATIONS, 'light');
  const fonts = await page.evaluate(() => ({
    check: document.fonts.check('16px Inter'),
    loaded: [...document.fonts]
      .filter((face) => face.status === 'loaded')
      .map((face) => face.family.replaceAll('"', '')),
  }));
  expect(fonts.check).toBe(true);
  expect(fonts.loaded).toContain('Inter');
});
