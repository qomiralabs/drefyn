import { tokens } from '../src/index.ts';
import { expect, FOUNDATIONS, openStory, test, THEMES } from './fixtures.ts';

for (const theme of THEMES) {
  test(`Tab reaches the focus sample with the token ring in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, FOUNDATIONS, theme);
    // Safari moves focus to links only with Option held, unless the user changed it.
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    const link = page.getByRole('link', { name: 'Back to the type scale' });
    await expect(link).toBeFocused();
    const ring = await link.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        style: style.outlineStyle,
        width: style.outlineWidth,
        offset: style.outlineOffset,
        color: style.outlineColor,
      };
    });
    const n = Number.parseInt(tokens.color.focus.ring[theme].slice(1), 16);
    expect(ring).toEqual({
      style: 'solid',
      width: `${tokens.stroke.focus}px`,
      offset: `${tokens.stroke.focusOffset}px`,
      color: `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`,
    });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#type-scale$/);
  });
}
