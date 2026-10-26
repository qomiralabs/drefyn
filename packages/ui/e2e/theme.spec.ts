import { tokens } from '../src/index.ts';
import { docsIds, expect, FOUNDATIONS, openPage, openStory, test, THEMES } from './fixtures.ts';

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

for (const theme of THEMES) {
  test(`${theme} sets data-theme on html and paints the token colours`, async ({ page }) => {
    await openStory(page, FOUNDATIONS, theme);
    const colours = await page.evaluate(() => {
      const ground = getComputedStyle(document.documentElement).backgroundColor;
      const heading = document.querySelector('#storybook-root h1');
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

for (const theme of THEMES) {
  test(`docs pages take the token ground, ink and Inter in ${theme}`, async ({ page }) => {
    const ids = docsIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      await openPage(page, { id, type: 'docs' }, theme);
      const look = await page.evaluate(() => {
        const wrapper = document.querySelector('#storybook-docs .sbdocs-wrapper');
        const content = document.querySelector('#storybook-docs .sbdocs-content');
        const title = document.querySelector('#storybook-docs .sbdocs-title');
        return {
          wrapper: wrapper ? getComputedStyle(wrapper).backgroundColor : '',
          font: content ? getComputedStyle(content).fontFamily : '',
          title: title ? getComputedStyle(title).color : '',
        };
      });
      expect(look.wrapper, id).toBe(rgb(tokens.color.surface.ground[theme]));
      expect(look.font, id).toMatch(/^"?Inter"?,/);
      expect(look.title, id).toBe(rgb(tokens.color.text.ink[theme]));
    }
  });
}
