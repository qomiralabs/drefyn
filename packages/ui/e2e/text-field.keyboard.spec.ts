import type { Locator } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const look = (el: Locator) =>
  el.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      ring: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`,
      edge: style.borderTopColor,
      fill: style.backgroundColor,
    };
  });

for (const theme of THEMES) {
  const ring = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusOffset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab reaches the field with the token ring outside its edge and typing edits it in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-text-field--default', theme);
    const input = page.getByRole('textbox', { name: 'Site name' });
    await page.keyboard.press(tabKey(browserName));
    await expect(input).toBeFocused();
    await expect
      .poll(() => look(input))
      .toEqual({
        ring,
        edge: rgb(tokens.color.border.control[theme]),
        fill: rgb(tokens.color.surface.ground[theme]),
      });
    await input.fill('');
    await page.keyboard.type('Acme handbook');
    await expect(input).toHaveValue('Acme handbook');
  });

  test(`an invalid field says why, joined to the input, with the broken edge in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-text-field--invalid', theme);
    const input = page.getByRole('textbox', { name: 'Address' });
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toHaveAccessibleDescription(
      'Lowercase letters, numbers and hyphens. Use lowercase letters, numbers and hyphens, such as acme-docs.',
    );
    await expect(input).toHaveCSS('border-top-color', rgb(tokens.color.state.broken.mark[theme]));
    await expect(
      page.getByText('Use lowercase letters, numbers and hyphens, such as acme-docs.'),
    ).toHaveCSS('color', rgb(tokens.color.state.broken.text[theme]));
  });

  test(`a disabled field is reached by Tab, shows the ring, reads its reason and ignores typing in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-text-field--disabled', theme);
    const input = page.getByRole('textbox', { name: 'Owner' });
    await page.keyboard.press(tabKey(browserName));
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-disabled', 'true');
    await expect(input).toHaveAccessibleDescription(
      'Only the current owner can hand the site over.',
    );
    await expect.poll(async () => (await look(input)).ring).toBe(ring);
    await page.keyboard.type('x');
    await page.keyboard.press('Backspace');
    await expect(input).toHaveValue('Ada Lovelace');
  });

  test(`a read only field is focusable and selectable but not editable in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-text-field--read-only', theme);
    const input = page.getByRole('textbox', { name: 'Site ID' });
    await page.keyboard.press(tabKey(browserName));
    await expect(input).toBeFocused();
    await page.keyboard.type('x');
    await expect(input).toHaveValue('site_fixture_8f2c');
    await expect(input).toHaveCSS('background-color', rgb(tokens.color.surface.raised[theme]));
    const selected = await input.evaluate((el) => {
      const field = el as HTMLInputElement;
      field.select();
      return (field.selectionEnd ?? 0) - (field.selectionStart ?? 0);
    });
    expect(selected).toBe('site_fixture_8f2c'.length);
  });
}
