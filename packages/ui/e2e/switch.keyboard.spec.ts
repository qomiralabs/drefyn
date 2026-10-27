import type { Locator, Page } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

// The input is hidden behind the drawn track, so the ring is looked for on whatever the
// switch draws, not on the input.
async function ringsInside(page: Page, name: string): Promise<string[]> {
  return page.getByRole('switch', { name }).evaluate((input) => {
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

for (const theme of THEMES) {
  const expectedRing = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusOffset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab reaches the switch with the token ring and Space flips it in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-switch--off', theme);
    const name = 'Show uptime figure';
    const toggle = page.getByRole('switch', { name });
    await expect(page.locator('#storybook-root')).toMatchAriaSnapshot(`
      - switch "Show uptime figure"
    `);
    await expect(toggle).toHaveAccessibleDescription(
      'Shows the 90 day figure under each component.',
    );
    await page.keyboard.press(tabKey(browserName));
    await expect(toggle).toBeFocused();
    await expect.poll(() => ringsInside(page, name)).toEqual([expectedRing]);
    expect(await checked(toggle)).toBe(false);
    // Space only: Enter on a checkbox in a form is the browser's submit key.
    await page.keyboard.press('Enter');
    expect(await checked(toggle)).toBe(false);
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(() => checked(toggle)).toBe(true);
    await page.keyboard.press('Enter');
    expect(await checked(toggle)).toBe(true);
    await page.keyboard.press('Space');
    await expect.poll(() => checked(toggle)).toBe(false);
  });

  test(`Tab moves through a list of switches in order in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-switch--settings', theme);
    for (const name of ['Require two regions to agree', 'Show uptime figure', 'Email updates']) {
      await page.keyboard.press(tabKey(browserName));
      await expect(page.getByRole('switch', { name })).toBeFocused();
    }
  });

  test(`a disabled switch is reached by Tab, reads its reason, and Space does nothing in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-switch--disabled', theme);
    for (const [name, on] of [
      ['Private page', false],
      ['Custom domain', true],
    ] as const) {
      const toggle = page.getByRole('switch', { name });
      await page.keyboard.press(tabKey(browserName));
      await expect(toggle, name).toBeFocused();
      await expect(toggle, name).toHaveAttribute('aria-disabled', 'true');
      await expect.poll(() => ringsInside(page, name), { message: name }).toEqual([expectedRing]);
      await page.keyboard.press('Space');
      // Playwright treats the label of an aria-disabled input as not enabled and would wait;
      // force still sends a real pointer click, which the switch must ignore.
      await page.getByText(name, { exact: true }).click({ force: true });
      expect(await checked(toggle), name).toBe(on);
    }
  });
}
