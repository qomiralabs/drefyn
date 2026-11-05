import { expect } from '@playwright/test';
import { MOBILE, openShell, ROUTES } from './fixtures.ts';
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

test.describe('the signed out brand half', () => {
  test.use({ storageState: SIGNED_OUT, viewport: { width: 1280, height: 800 } });

  test('its words do not animate under reduced motion', async ({ page }) => {
    await page.goto('/auth-states/sign-in/ready');
    await expect(page.locator('.auth-brand-copy')).toBeVisible();
    await expect(page.locator('.auth-brand')).toHaveAttribute('aria-hidden', 'true');
    const words = page.locator('.auth-brand-copy');
    expect(await words.evaluate((el) => el.getAnimations().length)).toBe(0);
  });
});
