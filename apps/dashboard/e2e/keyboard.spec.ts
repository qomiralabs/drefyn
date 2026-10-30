import { expect, test, type Page } from '@playwright/test';
import {
  addField,
  banner,
  commandBar,
  DESKTOP,
  focused,
  focusedRegion,
  main,
  MOBILE,
  notifications,
  openShell,
  products,
  ROUTES,
  tabKey,
} from './fixtures.ts';

test('Tab goes skip link, top bar left to right, then the sidebar', async ({
  page,
  browserName,
}) => {
  await openShell(page, ROUTES.overview);
  const order: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press(tabKey(browserName));
    order.push(await focused(page));
  }
  expect(order).toEqual([
    'a Skip to content',
    'a Acme overview',
    expect.stringMatching(/^button Acme/),
    expect.stringMatching(/^a Docs/),
    expect.stringMatching(/^a Studio/),
    expect.stringMatching(/^a Status/),
    expect.stringMatching(/^button .*Search or run a command/),
    expect.stringMatching(/^button Inbox/),
    expect.stringMatching(/^button MO/),
    expect.stringMatching(/^a Overview/),
  ]);
});

test.describe('command bar', () => {
  for (const key of ['Control+k', 'Meta+k']) {
    test(`${key} opens it with focus in its search field, and again closes it`, async ({
      page,
    }) => {
      await openShell(page, ROUTES.overview);
      await page.keyboard.press(key);
      await expect(commandBar(page)).toBeVisible();
      await expect(commandBar(page).getByRole('combobox')).toBeFocused();
      await page.keyboard.press(key);
      await expect(commandBar(page)).toBeHidden();
    });
  }

  test('opens from inside a text field', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const field = await addField(page);
    await field.focus();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(commandBar(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(commandBar(page)).toBeHidden();
    await expect(field).toBeFocused();
  });

  test('Escape closes it and returns focus to where it was', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const docs = products(page).getByRole('link', { name: /^Docs/ });
    await docs.focus();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(commandBar(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(commandBar(page)).toBeHidden();
    await expect(docs).toBeFocused();
  });

  test('the entry in the top bar opens it too, and focus returns to the entry', async ({
    page,
  }) => {
    await openShell(page, ROUTES.overview);
    const trigger = banner(page).getByRole('button', { name: /Search or run a command/ });
    await trigger.click();
    await expect(commandBar(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  });

  test('its code is not in the initial load; the first press fetches it', async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (req) => {
      if (req.resourceType() === 'script') scripts.push(req.url());
    });
    await openShell(page, ROUTES.overview);
    await page.waitForLoadState('networkidle');
    const before = scripts.length;
    await page.keyboard.press('ControlOrMeta+k');
    await expect(commandBar(page)).toBeVisible();
    expect(scripts.length, scripts.slice(before).join('\n')).toBeGreaterThan(before);
  });

  test('a failed chunk shows the error toast, no spinner, and the next press works', async ({
    page,
  }) => {
    await openShell(page, ROUTES.overview);
    await page.waitForLoadState('networkidle');
    await page.route('**/_next/static/**/*.js', (route) => route.abort('failed'));
    await page.keyboard.press('ControlOrMeta+k');
    const toast = page.getByRole('region', { name: /notification/i });
    // An error: announced at once, and it stays until dismissed.
    await expect(toast.getByRole('alert')).toHaveText('Could not open search. Try again.');
    await expect(commandBar(page)).toBeHidden();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await page.unrouteAll({ behavior: 'wait' });
    await page.keyboard.press('ControlOrMeta+k');
    await expect(commandBar(page)).toBeVisible();
  });
});

test('F6 and Shift+F6 move between the top bar, the sidebar and main', async ({ page }) => {
  await openShell(page, ROUTES.project);
  const forward: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('F6');
    forward.push(await focusedRegion(page));
  }
  expect(forward).toEqual(['banner', 'nav Payments API docs', 'main', 'banner']);
  await page.keyboard.press('Shift+F6');
  expect(await focusedRegion(page)).toBe('main');
});

// A placeholder action in the account menu says it is not available yet in a toast, which
// is the shared one from @drefyn/ui.
async function showToast(page: Page): Promise<void> {
  const account = banner(page).getByRole('button', { name: /^MO/ });
  await account.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: /Keyboard shortcuts/ }).click();
  await expect(
    notifications(page).getByText('The shortcuts sheet is not available yet.'),
  ).toBeVisible();
}

test('F6 goes into the notifications after main and out again, both ways', async ({ page }) => {
  await openShell(page, ROUTES.project);
  await showToast(page);
  await main(page).focus();
  const forward: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press('F6');
    forward.push(await focusedRegion(page));
  }
  expect(forward).toEqual(['notifications', 'banner']);
  const back: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    await page.keyboard.press('Shift+F6');
    back.push(await focusedRegion(page));
  }
  expect(back).toEqual(['notifications', 'main']);
  // The toast never took focus on its own: it got it only from F6.
  await expect(notifications(page)).toBeVisible();
});

test('the toast is the shared one: bottom left, Dismiss closes it, focus stays put', async ({
  page,
  browserName,
}) => {
  await page.setViewportSize(DESKTOP);
  await openShell(page, ROUTES.overview);
  await showToast(page);
  const region = notifications(page);
  const box = await region.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) return;
  expect(box.x).toBeLessThan(DESKTOP.width / 4);
  expect(DESKTOP.height - (box.y + box.height)).toBeLessThanOrEqual(24 + 1);
  await page.keyboard.press('F6');
  await expect(region).toBeFocused();
  await page.keyboard.press(tabKey(browserName));
  await page.keyboard.press(tabKey(browserName));
  await expect(region.getByRole('button', { name: 'Dismiss' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(region).toHaveCount(0);
});

test('on a phone F6 skips the sidebar that stepped aside for the drawer', async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await openShell(page, ROUTES.project);
  const forward: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('F6');
    forward.push(await focusedRegion(page));
  }
  expect(forward).toEqual(['banner', 'main', 'banner']);
});

test('G then 3 opens Status, but never from inside a field', async ({ page }) => {
  await openShell(page, ROUTES.project);
  const field = await addField(page);
  await field.focus();
  await page.keyboard.type('g3');
  await expect(field).toHaveValue('g3');
  await expect(page).toHaveURL(new RegExp(`${ROUTES.project}$`));
  await field.blur();
  await page.keyboard.press('g');
  await page.keyboard.press('3');
  await expect(page).toHaveURL(/\/acme\/status(\/[a-z0-9-]+)?$/);
});

test('the organization menu opens on Enter at its first item and Escape returns to the trigger', async ({
  page,
}) => {
  await openShell(page, ROUTES.overview);
  const trigger = banner(page).getByRole('button', { name: /^Acme/ });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Organization' });
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem').or(menu.getByRole('menuitemradio'));
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
});
