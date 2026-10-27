import type { Locator } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const ring = (el: Locator) =>
  el.evaluate((node) => {
    const style = getComputedStyle(node);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`;
  });

for (const theme of THEMES) {
  const expectedRing = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusOffset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab shows each tooltip at once, one at a time, and describes its button in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tooltip--toolbar', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('button', { name: 'Edit component' })).toBeFocused();
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    for (const name of ['Mark as verified', 'View history', 'More actions']) {
      await page.keyboard.press(tabKey(browserName));
      const button = page.getByRole('button', { name });
      await expect(button).toBeFocused();
      await expect.poll(() => ring(button)).toBe(expectedRing);
      const tip = page.getByRole('tooltip');
      await expect(tip).toHaveCount(1);
      await expect(tip).toHaveText(name);
      await expect(button).toHaveAccessibleDescription(name);
    }
  });

  test(`Escape closes the tooltip and leaves focus on its button in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tooltip--toolbar', theme);
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press(tabKey(browserName));
    const button = page.getByRole('button', { name: 'Mark as verified' });
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await expect(button).toBeFocused();
  });

  test(`hover shows the tooltip after the wait, and the pointer can move onto it in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-tooltip--toolbar', theme);
    const button = page.getByRole('button', { name: 'View history' });
    await button.hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveText('View history');
    await tip.hover();
    await expect(tip).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(tip).toHaveCount(0);
  });

  test(`a disabled button is reached by Tab and its tooltip says why in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-tooltip--disabled-reason', theme);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.keyboard.press(tabKey(browserName));
    const button = page.getByRole('button', { name: 'Publish update' });
    await expect(button).toBeFocused();
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('tooltip')).toHaveText('Only owners can publish this page.');
    await expect(button).toHaveAccessibleDescription('Only owners can publish this page.');
  });

  test(`the tooltip floats on the overlay surface in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-tooltip--open', theme);
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveText('More actions for Checkout');
    await expect(tip).toHaveCSS('background-color', rgb(tokens.color.surface.overlay[theme]));
    await expect(tip).toHaveCSS('color', rgb(tokens.color.text.body[theme]));
    await expect(tip).toHaveCSS('opacity', '1');
  });
}
