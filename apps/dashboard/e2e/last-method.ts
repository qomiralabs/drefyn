import { expect, type Locator, type Page } from '@playwright/test';

// The e2e servers run without secure cookies, so the names carry no __Host- prefix.
export const LAST_METHOD = 'drefyn_last_method';

export const lastMethodValue = async (page: Page): Promise<string | undefined> =>
  (await page.context().cookies()).find((cookie) => cookie.name === LAST_METHOD)?.value;

// Ends the session in this browser and nothing else, as coming back another day would.
export async function forgetSession(page: Page): Promise<void> {
  await page.context().clearCookies({ name: 'drefyn_session' });
}

export const marked = (page: Page) => page.getByRole('main').getByText('Last used');

// One mark on the page, inside the control it names, and read as part of that name.
export async function expectMarkOn(control: Locator): Promise<void> {
  await expect(control.page().getByRole('main').getByText('Last used')).toHaveCount(1);
  await expect(control).toHaveAccessibleName(/\S\s*,\s*Last used$/);
}
