import { expect, type Page } from '@playwright/test';
import { inbox, MOBILE, openShell, ROUTES, routeCommandBar } from './fixtures.ts';
import { SIGNED_OUT } from './people.ts';
import { test } from './test.ts';

// Runs in the reduced-motion project: nothing travels and fades finish within 120 ms.
test.use({ viewport: MOBILE });

const seconds = (list: string) =>
  list.split(',').map((v) => Number.parseFloat(v) * (v.trim().endsWith('ms') ? 0.001 : 1));

test('the drawer fades in place under reduced motion', async ({ page }) => {
  await openShell(page, ROUTES.project);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawer = page.getByRole('navigation', { name: 'Payments API docs' });
  await expect(drawer).toBeVisible();
  const timing = await drawer.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      transition: s.transitionDuration,
      animation: s.animationDuration,
      property: s.transitionProperty,
      animationName: s.animationName,
    };
  });
  for (const value of [...seconds(timing.transition), ...seconds(timing.animation)]) {
    expect(value).toBeLessThanOrEqual(0.12);
  }
  expect(timing.property).not.toMatch(/transform|translate|left|right|width/);
  const moving = await page.evaluate(
    () =>
      document.getAnimations().filter((a) => {
        const effect = a.effect as KeyframeEffect | null;
        return (effect?.getKeyframes() ?? []).some((k) => 'transform' in k || 'translate' in k);
      }).length,
  );
  expect(moving).toBe(0);
});

test('the command bar opens without travel under reduced motion', async ({ page }) => {
  await openShell(page, ROUTES.overview);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Search or run a command' })).toBeVisible();
  const moving = await page.evaluate(
    () =>
      document.getAnimations().filter((a) => {
        const effect = a.effect as KeyframeEffect | null;
        return (effect?.getKeyframes() ?? []).some((k) => 'transform' in k || 'translate' in k);
      }).length,
  );
  expect(moving).toBe(0);
});

const travelling = (page: Page) =>
  page.evaluate(
    () =>
      document.getAnimations().filter((a) => {
        const effect = a.effect as KeyframeEffect | null;
        return (effect?.getKeyframes() ?? []).some((k) => 'transform' in k || 'translate' in k);
      }).length,
  );

test('the inbox fades in place under reduced motion', async ({ page }) => {
  await openShell(page, ROUTES.success);
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(inbox(page)).toBeVisible();
  expect(await travelling(page)).toBe(0);
  const timing = await inbox(page).evaluate((el) => getComputedStyle(el).animationDuration);
  for (const value of seconds(timing)) expect(value).toBeLessThanOrEqual(0.12);
});

test('the command bar frame opens without travel while its code loads', async ({ page }) => {
  const chunk = await routeCommandBar(page, 'hold');
  await openShell(page, ROUTES.overview);
  await page.keyboard.press('ControlOrMeta+k');
  const bar = page.getByRole('dialog', { name: 'Search or run a command' });
  await expect(bar.locator('[data-pending-rows] > span').first()).toBeVisible();
  expect(await travelling(page)).toBe(0);
  chunk.release();
});

test('the shortcuts sheet opens without travel under reduced motion', async ({ page }) => {
  await openShell(page, ROUTES.overview);
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  expect(await travelling(page)).toBe(0);
});

test('a settings dialog opens without travel under reduced motion', async ({ page }) => {
  await openShell(page, '/settings-states/keys/revoke');
  await expect(page.getByRole('dialog', { name: 'Revoke ci-deploy?' })).toBeVisible();
  const moving = await page.evaluate(
    () =>
      document.getAnimations().filter((a) => {
        const effect = a.effect as KeyframeEffect | null;
        return (effect?.getKeyframes() ?? []).some((k) => 'transform' in k || 'translate' in k);
      }).length,
  );
  expect(moving).toBe(0);
});

test.describe('the signed out card', () => {
  test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 800 } });

  test('it does not animate under reduced motion', async ({ page }) => {
    await page.goto('/auth-states/sign-in/ready');
    const card = page.getByRole('complementary', { name: 'About Drefyn' });
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => el.getAnimations().length)).toBe(0);
    expect(await card.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  });
});
