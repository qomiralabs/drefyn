import type { Locator } from '@playwright/test';
import { tokens } from '../src/index.ts';
import { expect, openStory, rgb, tabKey, test, THEMES } from './fixtures.ts';

const ring = (el: Locator) =>
  el.evaluate((node) => {
    const style = getComputedStyle(node);
    return `${style.outlineStyle} ${style.outlineWidth} ${style.outlineOffset} ${style.outlineColor}`;
  });
const fill = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor);

for (const theme of THEMES) {
  const expectedRing = `solid ${tokens.stroke.focus}px ${tokens.stroke.focusOffset}px ${rgb(tokens.color.focus.ring[theme])}`;

  test(`Tab reaches the primary button with the token ring, and Enter and Space press it in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-button--primary', theme);
    const button = page.getByRole('button', { name: 'Publish update' });
    await page.keyboard.press(tabKey(browserName));
    await expect(button).toBeFocused();
    await expect.poll(() => ring(button)).toBe(expectedRing);
    const output = page.getByText(/^Presses: \d+$/);
    await expect(output).toHaveText('Presses: 0');
    await page.keyboard.press('Enter');
    await expect(output).toHaveText('Presses: 1');
    await page.keyboard.press('Space');
    await expect(output).toHaveText('Presses: 2');
    await expect(page.locator('#storybook-root')).toMatchAriaSnapshot(`
      - button "Publish update"
      - status: "Presses: 2"
    `);
  });

  test(`the primary button rests on accent ink and hovers to accent press in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-button--primary', theme);
    const button = page.getByRole('button', { name: 'Publish update' });
    await expect.poll(() => fill(button)).toBe(rgb(tokens.color.accent.ink[theme]));
    await button.hover();
    await expect.poll(() => fill(button)).toBe(rgb(tokens.color.accent.press[theme]));
  });

  test(`secondary and quiet buttons hover to the hover fill in ${theme}`, async ({ page }) => {
    for (const [id, name] of [
      ['components-button--secondary', 'Save draft'],
      ['components-button--quiet', 'Cancel'],
    ] as const) {
      await openStory(page, id, theme);
      const button = page.getByRole('button', { name });
      await button.hover();
      await expect
        .poll(() => fill(button), { message: id })
        .toBe(rgb(tokens.color.surface.hover[theme]));
    }
  });

  test(`a disabled button is reached by Tab, reads its reason, and ignores every press in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-button--disabled', theme);
    const output = page.getByText(/^Presses: \d+$/);
    const names = ['Publish update', 'Save draft', 'Discard'];
    for (const name of names) {
      const button = page.getByRole('button', { name });
      await page.keyboard.press(tabKey(browserName));
      await expect(button, name).toBeFocused();
      await expect(button, name).toHaveAttribute('aria-disabled', 'true');
      await expect(button, name).toHaveAccessibleDescription('Only owners can publish.');
      await expect.poll(() => ring(button), { message: name }).toBe(expectedRing);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await button.click();
    }
    await expect(output).toHaveText('Presses: 0');
  });

  test(`a disabled button keeps the disabled fill under the pointer in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-button--disabled', theme);
    const button = page.getByRole('button', { name: 'Publish update' });
    await button.hover();
    await expect.poll(() => fill(button)).toBe(rgb(tokens.color.disabled.fill[theme]));
  });

  test(`a busy button stays focusable and ignores presses in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-button--busy', theme);
    for (const name of ['Publishing', 'Saving draft']) {
      const button = page.getByRole('button', { name });
      await page.keyboard.press(tabKey(browserName));
      await expect(button, name).toBeFocused();
      await expect(button, name).toHaveAttribute('aria-disabled', 'true');
      await expect.poll(() => ring(button), { message: name }).toBe(expectedRing);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      await button.click();
    }
    await expect(page.getByText(/^Presses: \d+$/)).toHaveText('Presses: 0');
  });

  test(`pressing marks the region busy and the button shows the verb in progress, keeping focus in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-button--becomes-busy', theme);
    const region = page.getByRole('region', { name: 'Incident update' });
    await expect(region).not.toHaveAttribute('aria-busy', 'true');
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('button', { name: 'Publish update' })).toBeFocused();
    await page.keyboard.press('Enter');
    const busy = page.getByRole('button', { name: 'Publishing' });
    await expect(busy).toBeFocused();
    await expect(busy).toHaveAttribute('aria-disabled', 'true');
    await expect(busy).toHaveAttribute('data-busy');
    await expect(region).toHaveAttribute('aria-busy', 'true');
    await expect(busy.locator('svg, [role="progressbar"]')).toHaveCount(0);
    await expect.poll(() => busy.evaluate((el) => getComputedStyle(el).cursor)).toBe('progress');
    await expect.poll(() => fill(busy)).toBe(rgb(tokens.color.accent.ink[theme]));
  });

  test(`Tab walks the button links in order and Enter follows one in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, 'components-button--links', theme);
    const tab = tabKey(browserName);
    for (const name of ['View history', 'Create status page', /^Read the docs/]) {
      await page.keyboard.press(tab);
      const link = page.getByRole('link', { name });
      await expect(link).toBeFocused();
      await expect.poll(() => ring(link)).toBe(expectedRing);
    }
    await page.getByRole('link', { name: 'View history' }).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#history$/);
  });
}
