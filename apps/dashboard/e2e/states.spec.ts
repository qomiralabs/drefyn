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

test('the sidebar names the project with a plain link, not a menu it does not have', async ({
  page,
}) => {
  await openShell(page, ROUTES.project);
  const side = page.getByRole('navigation', { name: 'Payments API docs' });
  const project = side.getByRole('link', { name: /^Payments API docs/ });
  await expect(project).toHaveAttribute('href', '/acme/docs');
  await expect(project).not.toHaveAttribute('aria-haspopup', /.*/);
  await expect(project.locator('[data-icon="up-down"]')).toHaveCount(0);
});

test('the product home gives each project its own answer and says which is read only', async ({
  page,
}) => {
  await openShell(page, '/acme/docs');
  const rows = main(page).getByRole('listitem');
  const row = (name: string) => rows.filter({ has: page.getByRole('link', { name }) });
  await expect(row('Payments API docs')).toContainText('3 pages are out of date');
  await expect(row('New docs')).toContainText('No pages yet');
  const partner = row('Partner API docs');
  await expect(partner).toContainText('Read only. Nothing was deleted.');
  await expect(partner.getByRole('img', { name: 'Read only' })).toBeVisible();
  await expect(main(page).getByText('Docs project', { exact: true })).toHaveCount(0);
});
