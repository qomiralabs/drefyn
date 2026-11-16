import { expect, test } from '@playwright/test';
import { open, PAGES, WIDTHS, type Width } from './fixtures.ts';

// A status page has to work for a reader whose scripts are off or failed to load.
test.use({ javaScriptEnabled: false });

for (const target of PAGES) {
  for (const width of Object.keys(WIDTHS) as Width[]) {
    test(`${target.id} reads with scripts off at ${width}`, async ({ page }) => {
      await open(page, target, 'light', width, { scripts: false });
      // The stand in scripts mark the page, so this proves they really did not run.
      await expect(page.locator('html')).not.toHaveAttribute('data-script-ran');
      await expect(page.locator('main')).toBeVisible();
      for (const text of target.mustShow) {
        await expect(page.getByText(text).first(), text).toBeVisible();
      }
      // Every link goes somewhere without a script to send it there.
      await expect(page.locator('a:not([href]), a[href=""], a[href^="javascript:"]')).toHaveCount(
        0,
      );
    });
  }
}
