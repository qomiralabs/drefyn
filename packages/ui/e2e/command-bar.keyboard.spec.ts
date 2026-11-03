import type { Page } from '@playwright/test';
import { expect, MOBILE, openStory, tabKey, test, THEMES } from './fixtures.ts';

const STORY = 'components-command-bar--default';
const opener = (page: Page) => page.getByRole('button', { name: 'Search' });
const field = (page: Page) => page.getByRole('combobox', { name: 'Search or run a command' });
const output = (page: Page) => page.getByText(/^Last command: /);

// The row the field points at, read through aria-activedescendant, and the row React Aria
// draws as highlighted. A screen reader hears the first; a sighted person sees the second.
async function active(page: Page): Promise<{ named: string | null; highlighted: string[] }> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
    const id = input?.getAttribute('aria-activedescendant') ?? '';
    const named = id === '' ? null : document.getElementById(id);
    const label = (el: Element | null) => el?.querySelector('[data-label]')?.textContent ?? null;
    return {
      named: named?.getAttribute('role') === 'option' ? label(named) : null,
      highlighted: [...document.querySelectorAll('[role="option"][data-focused]')].map(
        (el) => label(el) ?? '',
      ),
    };
  });
}

const labels = (page: Page) => page.getByRole('option').locator('[data-label]').allTextContents();

async function openBar(page: Page, browserName: string) {
  await page.keyboard.press(tabKey(browserName));
  await expect(opener(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(field(page)).toBeFocused();
}

for (const theme of THEMES) {
  test(`typing filters and aria-activedescendant names the highlighted row in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openBar(page, browserName);
    await page.keyboard.type('stat');
    await expect
      .poll(() => labels(page))
      .toEqual(['Status page', 'Incidents', 'Start an incident']);
    // Grouped rows ship only if the field still names the row across the group boundary.
    await expect(page.getByRole('listbox').getByRole('group')).toHaveCount(2);
    // Typing highlights the first match, so Enter runs the best one at once.
    await expect
      .poll(() => active(page))
      .toEqual({
        named: 'Status page',
        highlighted: ['Status page'],
      });
    for (const [key, want] of [
      ['ArrowDown', 'Incidents'],
      ['ArrowDown', 'Start an incident'],
      ['ArrowUp', 'Incidents'],
    ] as const) {
      await page.keyboard.press(key);
      await expect.poll(() => active(page)).toEqual({ named: want, highlighted: [want] });
      await expect(field(page)).toBeFocused();
    }
    await page.keyboard.type('s');
    await expect.poll(() => labels(page)).toEqual([]);
    await expect(page.locator('[role="status"]')).toHaveText('No results for “stats”');
  });

  test(`Enter runs the highlighted row, closes and returns focus in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openBar(page, browserName);
    await page.keyboard.type('invite');
    await expect
      .poll(() => active(page))
      .toEqual({
        named: 'Invite people',
        highlighted: ['Invite people'],
      });
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(output(page)).toHaveText('Last command: invite');
    await expect(opener(page)).toBeFocused();
  });

  test(`Escape clears the query, then closes and returns focus in ${theme}`, async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, theme);
    await openBar(page, browserName);
    await page.keyboard.type('docs');
    await page.keyboard.press('Escape');
    await expect(field(page)).toHaveValue('');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener(page)).toBeFocused();
    await expect(output(page)).toHaveText('Last command: none');
  });

  test(`focus stays in the bar while it is open in ${theme}`, async ({ page, browserName }) => {
    await openStory(page, STORY, theme);
    await openBar(page, browserName);
    const dialog = page.getByRole('dialog');
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press(tabKey(browserName));
      await expect
        .poll(() => dialog.evaluate((el) => el.contains(document.activeElement)))
        .toBe(true);
    }
  });

  test(`a disabled row is reached by the arrows, reads its reason and never runs in ${theme}`, async ({
    page,
  }) => {
    await openStory(page, 'components-command-bar--disabled', theme);
    await expect(field(page)).toBeFocused();
    await page.keyboard.type('delete');
    await expect
      .poll(() => active(page))
      .toEqual({
        named: 'Delete the project',
        highlighted: ['Delete the project'],
      });
    const row = page.getByRole('option', { name: /Delete the project/ });
    await expect(row).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toHaveAccessibleDescription('Only an owner can delete a project');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(output(page)).toHaveText('Last command: none');
  });

  test(`a failed search offers Retry as a row that Enter runs in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-command-bar--failed', theme);
    await expect(page.getByRole('alert')).toContainText('Search is not answering.');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => active(page)).toEqual({ named: 'Retry', highlighted: ['Retry'] });
    await page.keyboard.press('Enter');
    await expect(page.getByText(/^Retries: /)).toHaveText('Retries: 1');
  });

  test(`loading keeps the field and marks the results busy in ${theme}`, async ({ page }) => {
    await openStory(page, 'components-command-bar--loading', theme);
    await expect(field(page)).toBeFocused();
    await expect(page.getByRole('listbox')).toHaveAttribute('aria-busy', 'true');
  });
}

// On a phone the bar fills the screen and Cancel is the way out by touch.
test.describe('on a phone', () => {
  test.use({ viewport: MOBILE });

  test('the bar fills the screen and Cancel closes it back to the opener', async ({
    page,
    browserName,
  }) => {
    await openStory(page, STORY, 'light');
    await openBar(page, browserName);
    const box = await page.getByRole('dialog').boundingBox();
    expect(box).toEqual({ x: 0, y: 0, width: MOBILE.width, height: MOBILE.height });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(opener(page)).toBeFocused();
  });
});
