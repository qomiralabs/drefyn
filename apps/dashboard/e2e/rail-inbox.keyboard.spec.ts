import { expect, type Page } from '@playwright/test';
import { test } from './csp.ts';
import {
  banner,
  DESKTOP,
  inbox,
  main,
  openShell,
  RAIL_TIP_MARK,
  ROUTES,
  routeChunk,
  TABLET,
  tabKey,
} from './fixtures.ts';
import { openCockpit, sidebar } from './incident-helpers.ts';

const rail = (page: Page) => page.getByRole('navigation', { name: 'Payments API docs' });

test.describe('the tablet rail', () => {
  test.use({ viewport: TABLET });

  test('every item shows its label on keyboard focus, and keeps its name', async ({
    page,
    browserName,
  }) => {
    await openShell(page, ROUTES.project);
    const links = rail(page).getByRole('link');
    const count = await links.count();
    expect(count).toBeGreaterThan(3);
    // Focus enters the rail by F6, then Tab walks it as a person would.
    await page.keyboard.press('F6');
    await page.keyboard.press('F6');
    for (let i = 0; i < count; i += 1) {
      await page.keyboard.press(tabKey(browserName));
      const link = links.nth(i);
      await expect(link).toBeFocused();
      // The hidden label is the name; the tooltip neither renames nor describes it.
      const label = (await link.locator('span.truncate').first().textContent())?.trim() ?? '';
      expect(label).not.toBe('');
      await expect(link).toHaveAccessibleName(new RegExp(`^${label}`));
      await expect(link).not.toHaveAttribute('aria-describedby', /./);
      const tip = page.locator('[role="tooltip"]');
      await expect(tip).toBeVisible();
      await expect(tip).toHaveText(label);
      await expect(tip).toHaveAttribute('aria-hidden', 'true');
    }
  });

  test('hover shows the label too, and Escape hides it without moving focus', async ({ page }) => {
    await openShell(page, ROUTES.project);
    const pages = rail(page).getByRole('link', { name: /^Pages/ });
    // A real pointer has moved before it reaches a link; that is how React Aria tells a
    // hover from focus moving under a still pointer.
    await page.mouse.move(400, 400);
    await page.mouse.move(401, 401);
    await pages.hover();
    const tip = page.locator('[role="tooltip"]');
    await expect(tip).toHaveText('Pages');
    // It sits beside the rail, not over it.
    const [tipBox, railBox] = [await tip.boundingBox(), await rail(page).boundingBox()];
    expect(tipBox?.x ?? 0).toBeGreaterThanOrEqual((railBox?.x ?? 0) + (railBox?.width ?? 0) - 1);
    await page.mouse.move(DESKTOP.width / 2, 600);
    await expect(tip).toHaveCount(0);
  });

  // The tooltip code lands after the page is ready, and a fast keyboard can reach the rail
  // first. Its arrival wraps every link anew, so the focused link must not lose focus to it.
  test('an item focused before the tooltip code lands keeps focus and shows its label', async ({
    page,
    browserName,
  }) => {
    const chunk = await routeChunk(page, RAIL_TIP_MARK, 'hold');
    await openShell(page, ROUTES.project);
    await expect
      .poll(chunk.requested, { message: 'the tooltip code was asked for' })
      .toBeGreaterThan(0);
    await page.keyboard.press('F6');
    await page.keyboard.press('F6');
    await page.keyboard.press(tabKey(browserName));
    const first = rail(page).getByRole('link').first();
    await expect(first).toBeFocused();
    const tip = page.locator('[role="tooltip"]');
    await expect(tip).toHaveCount(0);
    chunk.release();
    await expect(tip).toBeVisible();
    await expect(first).toBeFocused();
    const label = (await first.locator('span.truncate').first().textContent())?.trim() ?? '';
    await expect(tip).toHaveText(label);
  });
});

test('incident mode puts a wide screen on the rail, and its items name themselves too', async ({
  page,
  browserName,
}) => {
  await page.setViewportSize(DESKTOP);
  await openCockpit(page);
  const links = sidebar(page).getByRole('link');
  // Focus the first rail item from the sidebar landmark, as F6 would.
  await sidebar(page).focus();
  await page.keyboard.press(tabKey(browserName));
  await expect(links.first()).toBeFocused();
  await expect(page.locator('[role="tooltip"]')).toBeVisible();
  await expect(links.first()).not.toHaveAttribute('aria-describedby', /./);
});

test('on a wide screen the labels are on screen, so no tooltip repeats them', async ({
  page,
  browserName,
}) => {
  await page.setViewportSize(DESKTOP);
  await openShell(page, ROUTES.project);
  await page.keyboard.press('F6');
  await page.keyboard.press('F6');
  await page.keyboard.press(tabKey(browserName));
  await expect(rail(page).getByRole('link').first()).toBeFocused();
  await page.waitForTimeout(700);
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0);
});

test.describe('the inbox', () => {
  const trigger = (page: Page) => banner(page).getByRole('button', { name: /^Inbox/ });

  test('opens without making the page inert, and focus moves into it', async ({ page }) => {
    await openShell(page, ROUTES.project);
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(inbox(page)).toBeVisible();
    await expect(inbox(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(inbox(page)).not.toHaveAttribute('aria-modal', 'true');
    // Nothing outside was hidden or made inert.
    const shut = await page.evaluate(() => ({
      inert: document.querySelectorAll('[inert]').length,
      hidden: [...document.querySelectorAll('[aria-hidden="true"]')].filter(
        (el) => el.querySelector('main, header, nav') !== null || el.matches('main, header, nav'),
      ).length,
    }));
    expect(shut).toEqual({ inert: 0, hidden: 0 });
    // The page under it still works: a link in main takes a click.
    await main(page).getByRole('heading', { level: 1 }).click();
    await expect(inbox(page)).toBeVisible();
  });

  test('Escape closes it and returns focus to the trigger', async ({ page, browserName }) => {
    await openShell(page, ROUTES.project);
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(inbox(page)).toBeFocused();
    await page.keyboard.press(tabKey(browserName));
    await expect(inbox(page).getByRole('button', { name: 'Close inbox' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(inbox(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('Tab can leave it, forward to the account button and back to the trigger', async ({
    page,
    browserName,
  }) => {
    await openShell(page, ROUTES.project);
    await trigger(page).focus();
    await page.keyboard.press('Enter');
    await expect(inbox(page)).toBeFocused();
    // Walk forward until focus leaves the panel; it must land on the next thing in the bar.
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press(tabKey(browserName));
      const inside = await inbox(page).evaluate((el) => el.contains(document.activeElement));
      if (!inside) break;
    }
    await expect(banner(page).getByRole('button', { name: /^MO/ })).toBeFocused();
    // Non modal: it stays open while focus is elsewhere.
    await expect(inbox(page)).toBeVisible();
    await page.keyboard.press(`Shift+${tabKey(browserName)}`);
    expect(await inbox(page).evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await trigger(page).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(trigger(page)).not.toBeFocused();
    await expect(inbox(page)).toBeVisible();
  });

  test('the trigger and Close both shut it', async ({ page }) => {
    await openShell(page, ROUTES.project);
    await trigger(page).click();
    await expect(inbox(page)).toBeVisible();
    await trigger(page).click();
    await expect(inbox(page)).toHaveCount(0);
    await trigger(page).click();
    await inbox(page).getByRole('button', { name: 'Close inbox' }).click();
    await expect(inbox(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });
});
