import { expect, type Page } from '@playwright/test';
import { test } from './csp.ts';
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
import { askForCode, uniqueAddress } from './auth-helpers.ts';
import { expectMarkOn } from './last-method.ts';
import { SIGNED_OUT } from './people.ts';

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

// Text only the command bar's own chunk carries: its empty results line.
const COMMAND_BAR_MARK = 'Nothing matches';

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
    // The command bar's chunk fails however and whenever it is fetched, by its content, not
    // by timing: a route set after the load missed a copy fetched while the page settled.
    let blocked = 0;
    await page.route('**/_next/static/**/*.js', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      if (body.includes(COMMAND_BAR_MARK)) {
        blocked += 1;
        await route.abort('failed');
        return;
      }
      await route.fulfill({ response, body });
    });
    await openShell(page, ROUTES.overview);
    await page.keyboard.press('ControlOrMeta+k');
    const toast = page.getByRole('region', { name: /notification/i });
    // An error: announced at once, and it stays until dismissed.
    await expect(toast.getByRole('alert')).toHaveText('Could not open search. Try again.');
    await expect(commandBar(page)).toBeHidden();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    expect(blocked, 'the command bar chunk was requested and refused').toBeGreaterThan(0);
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

test('the toast is the shared one: bottom left, Shift+F6 from the bar reaches it, Dismiss closes it', async ({
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
  // Focus is back on the account menu in the bar; the notifications are last in the cycle.
  await page.keyboard.press('Shift+F6');
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

test.describe('signed out pages', () => {
  test.use({ storageState: SIGNED_OUT });

  test('sign in opens in the address, and Enter sends the code', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByLabel('Email address')).toBeFocused();
    await page.keyboard.type(uniqueAddress('keys'));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/sign-in\/verify/);
  });

  test('verify opens in the code, and Enter submits it', async ({ page }) => {
    await askForCode(page, uniqueAddress('keys'));
    await expect(page.getByLabel('8 digit code')).toBeFocused();
    await page.keyboard.type('00000000');
    await page.keyboard.press('Enter');
    await expect(page.getByText('That code did not work.')).toBeVisible();
  });

  test('the password form completes from the keyboard', async ({ page, browserName }) => {
    await page.goto('/sign-in/password');
    await page.getByLabel('Email address').focus();
    await page.keyboard.type(uniqueAddress('keys'));
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await page.keyboard.type('a wrong password of some length');
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.keyboard.press(tabKey(browserName));
    await page.keyboard.press('Enter');
    await expect(page.getByText('That address and password do not match.')).toBeVisible();
  });

  test('Welcome goes name, password, Show, Continue, Sign out', async ({ page, browserName }) => {
    await page.goto('/auth-states/welcome/ready');
    await expect(page.getByLabel('Your name')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password (optional)', { exact: true })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('button', { name: 'Continue' })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeFocused();
  });

  test('Create organization goes name, Create, Sign out', async ({ page, browserName }) => {
    await page.goto('/auth-states/organization/ready');
    await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Create organization' })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeFocused();
  });

  test('a stopped Create organization stays focusable and says why', async ({ page }) => {
    await page.goto('/auth-states/organization/limited');
    const button = page.getByRole('button', { name: 'Create organization' });
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleDescription('Paused until tomorrow.');
    await button.focus();
    await expect(button).toBeFocused();
  });

  test('Last used is part of the name of the control it marks', async ({ page }) => {
    for (const [state, control] of [
      ['last-github', page.getByRole('link', { name: /^Continue with GitHub/ })],
      ['last-google', page.getByRole('link', { name: /^Continue with Google/ })],
      ['last-email-code', page.getByRole('button', { name: /^Email me a code/ })],
      ['last-password', page.getByRole('link', { name: /^Use a password instead/ })],
    ] as const) {
      await page.goto(`/auth-states/sign-in/${state}`);
      await expectMarkOn(control);
    }
  });

  test('the card is a named aside that Tab never enters', async ({ page, browserName }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/auth-states/sign-in/ready');
    await expect(page.getByRole('complementary', { name: 'About Drefyn' })).toBeVisible();
    // Blurring the autofocused field keeps it as the start point, so the walk starts at the
    // top on purpose.
    await page.getByRole('link', { name: 'Skip to content' }).focus();
    const stops: string[] = [await focused(page)];
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press(tabKey(browserName));
      const here = await focused(page);
      // Past the last stop focus leaves the page or wraps to the top.
      if (here === 'body' || here === stops[0]) break;
      const inCard = await page.evaluate(() => document.activeElement?.closest('aside') !== null);
      stops.push(inCard ? `card ${here}` : here);
    }
    expect(stops.slice(0, 3)).toEqual([
      'a Skip to content',
      'a Drefyn, sign in',
      'a Documentation',
    ]);
    expect(stops.at(-1)).toBe('a Create an account');
    expect(stops.filter((stop) => stop.startsWith('card '))).toEqual([]);
  });

  test('the first Tab reaches the skip link, and it moves to main', async ({
    page,
    browserName,
  }) => {
    await page.goto('/auth-states/block/done');
    await page.keyboard.press(tabKey(browserName));
    expect(await focused(page)).toBe('a Skip to content');
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });
});

test.describe('settings', () => {
  test('a dialog that cannot be undone opens on Cancel, and Escape closes it', async ({
    page,
    browserName,
  }) => {
    await openShell(page, '/settings-states/sessions/ready');
    const everywhere = page.getByRole('button', { name: 'Sign out everywhere else' });
    await everywhere.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Sign out everywhere else?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(dialog.getByRole('button', { name: 'Sign out 2 sessions' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(everywhere).toBeFocused();
  });

  test('a filter opens by keyboard and reads what is chosen', async ({ page }) => {
    await openShell(page, '/settings-states/members/ready');
    const role = page.getByRole('button', { name: /^Role/ }).first();
    await role.focus();
    await page.keyboard.press('Enter');
    const admin = page.getByRole('menuitemcheckbox', { name: 'Admin' });
    await page.keyboard.press('ArrowDown');
    await expect(admin).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(admin).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(role).toBeFocused();
    await expect(role).toContainText('Admin');
  });

  test('an action that cannot run stays focusable and says why', async ({ page }) => {
    await openShell(page, '/settings-states/methods/only-one');
    const unlink = page.getByRole('button', { name: 'Unlink GitHub' });
    await unlink.focus();
    await expect(unlink).toBeFocused();
    await expect(unlink).toHaveAttribute('aria-disabled', 'true');
    await expect(unlink).toHaveAccessibleDescription(/only way to sign in/);
  });
});
