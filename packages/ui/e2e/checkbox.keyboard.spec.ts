import type { Locator, Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

// The input sits under the drawn box, so the ring is looked for on what the checkbox draws.
async function ringsInside(page: Page, name: string): Promise<string[]> {
  return page.getByRole('checkbox', { name }).evaluate((input) => {
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

const checked = (el: Locator) => el.evaluate((input) => (input as HTMLInputElement).checked);
const mixed = (el: Locator) => el.evaluate((input) => (input as HTMLInputElement).indeterminate);

for (const theme of THEMES) {
  const ring = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusOffset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab reaches the box with the token ring, Space toggles and Enter does not in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-checkbox--with-description', theme);
    const name = 'Send a daily digest';
    const box = page.getByRole('checkbox', { name });
    await expect(page.locator('#storybook-root')).toMatchAriaSnapshot(`
      - checkbox "Send a daily digest"
    `);
    await expect(box).toHaveAccessibleDescription(
      'One email a day at 9:00, only when something changed.',
    );
    await page.keyboard.press(tabKey(browserName));
    await expect(box).toBeFocused();
    await expect.poll(() => ringsInside(page, name)).toEqual([ring]);
    await page.keyboard.press('Enter');
    expect(await checked(box)).toBe(false);
    await page.keyboard.press('Space');
    await expect.poll(() => checked(box)).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(() => checked(box)).toBe(false);
  });

  test(`select all reads as mixed while some rows are picked in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-checkbox--indeterminate', theme);
    const all = page.getByRole('checkbox', { name: 'Select all pages' });
    expect(await mixed(all)).toBe(true);
    await expect(all).toBeChecked({ indeterminate: true });
    await page.keyboard.press(tabKey(browserName));
    await expect(all).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(() => mixed(all)).toBe(false);
    await expect(all).toBeChecked();
    for (const row of ['Getting started', 'Billing API', 'Webhooks']) {
      await expect(page.getByRole('checkbox', { name: row }), row).toBeChecked();
    }
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('Space');
    await expect.poll(() => mixed(all)).toBe(true);
  });

  test(`an invalid box names its error in its description in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-checkbox--invalid', theme);
    const box = page.getByRole('checkbox', { name: 'I agree to the terms of service' });
    await expect(box).toHaveAttribute('aria-invalid', 'true');
    await expect(box).toHaveAccessibleDescription(/Agree to the terms to create the site\./);
  });

  test(`a disabled box is reached by Tab, reads its reason, and ignores Space and clicks in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-checkbox--disabled', theme);
    for (const [name, on, reason] of [
      ['Email me before a renewal', false, 'Only owners can change billing alerts.'],
      ['Email me about sign ins', true, 'Security alerts always go to owners.'],
    ] as const) {
      const box = page.getByRole('checkbox', { name });
      await page.keyboard.press(tabKey(browserName));
      await expect(box, name).toBeFocused();
      await expect(box, name).toHaveAttribute('aria-disabled', 'true');
      await expect(box, name).toHaveAccessibleDescription(reason);
      await expect.poll(() => ringsInside(page, name), { message: name }).toEqual([ring]);
      await page.keyboard.press('Space');
      // Playwright waits on the label of an aria-disabled input; force still sends a real
      // pointer click, which the box must ignore.
      await page.getByText(name, { exact: true }).click({ force: true });
      expect(await checked(box), name).toBe(on);
    }
  });
}
