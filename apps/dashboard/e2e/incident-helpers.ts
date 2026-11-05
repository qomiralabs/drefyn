import { expect, type Locator, type Page } from '@playwright/test';
import { commandBar, openShell } from './fixtures.ts';
import { PAGES } from './undo-helpers.ts';

export const STATUS = '/acme/status/acme-status';
export const COCKPIT = `${STATUS}/incidents/inc-payments-europe`;
export const DOCS_PAGES = PAGES;

// Words only the cockpit chunk holds, so a script that has them is that chunk.
export const COCKPIT_MARK = 'Update waiting for you';

export const line = (page: Page): Locator =>
  page.getByRole('region', { name: 'Incident in progress' });
export const heading = (page: Page): Locator =>
  page.getByRole('heading', { level: 1, name: /Payments API is failing in Europe/ });
export const said = (page: Page, tone: 'polite' | 'assertive'): Locator =>
  page.locator(`[data-announcer="${tone}"]`);
export const sidebar = (page: Page): Locator => page.locator('#shell-nav');

// An incident already open when the page loads, without any of the steps that open one.
export async function incidentOpen(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('dr-incident-fixture:acme', 'inc-payments-europe');
  });
}

export async function startFromCommandBar(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(commandBar(page)).toBeVisible();
  await page.keyboard.type('Start an incident');
  await expect(commandBar(page).getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
}

export async function openCockpit(page: Page): Promise<void> {
  await incidentOpen(page);
  await openShell(page, COCKPIT);
  await expect(heading(page)).toBeVisible();
}

export const barWidth = (page: Page): Promise<number> =>
  sidebar(page).evaluate((el) => el.getBoundingClientRect().width);
