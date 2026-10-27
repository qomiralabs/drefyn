import { expect, test } from '@playwright/test';
import { ANSWERS, main, openShell, products, ROUTES } from './fixtures.ts';

test('loading: the shell renders at once and main holds skeletons, busy and named', async ({
  page,
}) => {
  // The pending project never answers, so the loading state stays for the whole test.
  await page.goto(ROUTES.loading, { waitUntil: 'commit' });
  await expect(products(page).getByRole('link')).toHaveCount(3);
  await expect(main(page)).toHaveAttribute('aria-busy', 'true');
  const heading = main(page).getByRole('heading', { level: 1 });
  await expect(heading).toHaveText('Pending docs');
  // Named for assistive tech, not drawn.
  await expect(heading).toHaveCSS('position', 'absolute');
  await expect(
    main(page).locator('[aria-hidden="true"][class~="bg-skeleton-fill"]').first(),
  ).toBeVisible();
  await expect(main(page).getByRole('progressbar')).toHaveCount(0);
  await expect(main(page).locator('[class*="spin" i]')).toHaveCount(0);
});

test('empty: the answer says so and offers one primary action', async ({ page }) => {
  await openShell(page, ROUTES.empty);
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(ANSWERS.empty);
  await expect(main(page)).not.toHaveAttribute('aria-busy', 'true');
  // Button and ButtonLink paint the primary variant with the accent ink fill.
  const primary = main(page).locator('a.bg-accent-ink, button.bg-accent-ink');
  await expect(primary).toHaveCount(1);
  await expect(primary).toBeVisible();
});

test('error: says what still works, gives a reference and Try again, and the shell stays usable', async ({
  page,
}) => {
  await openShell(page, ROUTES.error);
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(ANSWERS.error);
  await expect(main(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(main(page).locator('code, samp').first()).toBeVisible();
  await expect(main(page).getByRole('link', { name: /status\.drefyn\.com/ })).toHaveAttribute(
    'href',
    'https://status.drefyn.com',
  );
  await products(page).getByRole('link', { name: /^Docs/ }).focus();
  await expect(products(page).getByRole('link', { name: /^Docs/ })).toBeFocused();
});

test('success: the project home shows its answer and the evidence under it', async ({ page }) => {
  await openShell(page, ROUTES.project);
  await expect(main(page).getByRole('heading', { level: 1 })).toHaveText(ANSWERS.project);
  await expect(main(page).locator('time').first()).toBeVisible();
  // Depth is a ranked list, never a card grid.
  await expect(main(page).getByRole('list').first()).toBeVisible();
});
