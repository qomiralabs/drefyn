import type { Locator } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, FOUNDATIONS, openStory, test, THEMES } from './fixtures.ts';

const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const look = (row: Locator) =>
  row.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      background: style.backgroundColor,
      translate: style.translate,
      outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset}`,
    };
  });

const ROWS = [
  { name: 'Fade, fast', moves: false },
  { name: 'Fade, base', moves: false },
  { name: 'Fade, slow', moves: false },
  { name: 'Move, base', moves: true },
];

for (const theme of THEMES) {
  test(`Tab reaches the focus sample with the token ring in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, FOUNDATIONS, theme);
    // Safari moves focus to links and buttons only with Option held, unless the user
    // changed it.
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
    expect(ring).toEqual({
      style: 'solid',
      width: `${tokens.stroke.focus}px`,
      offset: `${tokens.stroke.focusOffset}px`,
      color: rgb(tokens.color.focus.ring[theme]),
    });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#type-scale$/);
  });

  test(`Tab walks the motion rows, and each shows focus and toggles in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, FOUNDATIONS, theme);
    const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
    await page.keyboard.press(tab);
    await expect(page.getByRole('link', { name: 'Back to the type scale' })).toBeFocused();
    for (const { name, moves } of ROWS) {
      const row = page.getByRole('button', { name: new RegExp(`^${name}`) });
      const rest = await look(row);
      expect(rest.translate, name).toBe('none');
      await page.keyboard.press(tab);
      await expect(row).toBeFocused();
      await expect(row).toHaveAttribute('aria-pressed', 'false');
      // Focus is drawn inside the row, since rows sit flush in the list.
      await expect
        .poll(async () => (await look(row)).outline, { message: name })
        .toBe(`solid ${tokens.stroke.focus}px ${tokens.stroke.focusInset}px`);
      if (moves) {
        await expect
          .poll(async () => (await look(row)).translate, { message: name })
          .not.toBe('none');
      } else {
        await expect
          .poll(async () => (await look(row)).background, { message: name })
          .toBe(rgb(tokens.color.surface.hover[theme]));
      }
      await page.keyboard.press('Space');
      await expect(row).toHaveAttribute('aria-pressed', 'true');
      await expect
        .poll(async () => (await look(row)).background, { message: name })
        .toBe(rgb(tokens.color.surface.pressed[theme]));
    }
  });
}
