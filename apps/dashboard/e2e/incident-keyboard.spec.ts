import { expect } from '@playwright/test';
import { focused, openShell, tabKey } from './fixtures.ts';
import { heading, incidentOpen, line, startFromCommandBar, STATUS } from './incident-helpers.ts';
import { test } from './test.ts';

test('the whole shift works from the keyboard', async ({ page, browserName }) => {
  await openShell(page, STATUS);
  await startFromCommandBar(page);
  await expect(heading(page)).toBeFocused();
  await page.keyboard.press(tabKey(browserName));
  expect(await focused(page)).toBe('button Resolve incident');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(STATUS);
  await expect(line(page)).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeFocused();
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toContainText(
    'No monitors yet.',
  );
});

test('F6 reaches the incident line', async ({ page }) => {
  await incidentOpen(page);
  await openShell(page, STATUS);
  await expect(line(page)).toBeVisible();
  await expect
    .poll(async () => {
      await page.keyboard.press('F6');
      return page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    })
    .toBe('Incident in progress');
});
