import { expect } from '@playwright/test';
import { test } from './test.ts';
import { archive, openPages, row, select, toastRegion } from './undo-helpers.ts';

// Runs in the reduced-motion project. Rows leave and return in one step, and nothing travels.
test('archive and Undo move nothing under reduced motion', async ({ page }) => {
  await openPages(page);
  await select(page, 'Refunds');
  await archive(page).click();
  await expect(toastRegion(page).getByText('Archived Refunds.')).toBeVisible();
  const travelling = () =>
    page.evaluate(
      () =>
        document.getAnimations().filter((a) => {
          const effect = a.effect as KeyframeEffect | null;
          return (effect?.getKeyframes() ?? []).some((k) => 'transform' in k || 'translate' in k);
        }).length,
    );
  expect(await travelling()).toBe(0);
  await toastRegion(page).getByRole('button', { name: 'Undo' }).click();
  await expect(row(page, 'Refunds')).toHaveCount(1);
  expect(await travelling()).toBe(0);
});
