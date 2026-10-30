import type { Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const radio = (page: Page, name: string) => page.getByRole('radio', { name, exact: true });

async function ringsInside(page: Page, name: string): Promise<string[]> {
  return radio(page, name).evaluate((input) => {
    const label = input.closest('label') ?? input.parentElement;
    if (label === null) return [];
    return [label, ...label.querySelectorAll('*')]
      .map((el) => getComputedStyle(el))
      .filter((style) => style.outlineStyle !== 'none' && style.outlineWidth !== '0px')
      .map(
        (style) =>
          `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`,
      );
  });
}

for (const theme of THEMES) {
  const ring = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusOffset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab enters on the chosen radio and the arrows move and choose in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-radio-group--default', theme);
    await expect(page.locator('#storybook-root')).toMatchAriaSnapshot(`
      - radiogroup "Role":
        - radio "Owner"
        - radio "Editor" [checked]
        - radio "Viewer"
    `);
    await page.keyboard.press(tabKey(browserName));
    await expect(radio(page, 'Editor')).toBeFocused();
    await expect.poll(() => ringsInside(page, 'Editor')).toEqual([ring]);
    await page.keyboard.press('ArrowDown');
    await expect(radio(page, 'Viewer')).toBeFocused();
    await expect(radio(page, 'Viewer')).toBeChecked();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(radio(page, 'Owner')).toBeFocused();
    await expect(radio(page, 'Owner')).toBeChecked();
    await expect(radio(page, 'Editor')).not.toBeChecked();
  });

  test(`a group with nothing chosen is entered on its first radio, and Space chooses in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-radio-group--with-descriptions', theme);
    await page.keyboard.press(tabKey(browserName));
    const first = radio(page, 'Public');
    await expect(first).toBeFocused();
    await expect(first).toHaveAccessibleDescription('Anyone with the link, and search engines.');
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
  });

  test(`the arrows reach a disabled radio but never choose it in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-radio-group--disabled', theme);
    await page.keyboard.press(tabKey(browserName));
    await expect(radio(page, 'Editor')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    const owner = radio(page, 'Owner');
    await expect(owner).toBeFocused();
    await expect(owner).toHaveAttribute('aria-disabled', 'true');
    await expect(owner).toHaveAccessibleDescription('Only an owner can make another owner.');
    await expect(owner).not.toBeChecked();
    await expect(radio(page, 'Editor')).toBeChecked();
    await page.keyboard.press('Space');
    await expect(owner).not.toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(radio(page, 'Editor')).toBeFocused();
    await expect(radio(page, 'Editor')).toBeChecked();
  });

  test(`a disabled group stays focusable, reads its reason and keeps its choice in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-radio-group--disabled', theme);
    const group = page.getByRole('radiogroup', { name: 'Data region' });
    await expect(group).toHaveAttribute('aria-disabled', 'true');
    await expect(group).toHaveAccessibleDescription('The region is fixed once the site has pages.');
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press(tabKey(browserName));
    const eu = radio(page, 'Europe');
    await expect(eu).toBeFocused();
    await expect.poll(() => ringsInside(page, 'Europe')).toEqual([ring]);
    await page.keyboard.press('ArrowDown');
    await radio(page, 'United States').click({ force: true });
    await expect(eu).toBeChecked();
    await expect(radio(page, 'United States')).not.toBeChecked();
  });

  test(`an invalid group names its error in its description in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-radio-group--invalid', theme);
    const group = page.getByRole('radiogroup', { name: 'Role' });
    await expect(group).toHaveAttribute('aria-invalid', 'true');
    await expect(group).toHaveAccessibleDescription('Choose a role to send the invite.');
  });
}
