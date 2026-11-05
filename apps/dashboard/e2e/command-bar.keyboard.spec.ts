import { expect, type Page } from '@playwright/test';
import { startIncidentCommand } from '../src/incident/feed.ts';
import { places } from '../src/shell/places.ts';
import type { Command } from '../src/shell/commands.ts';
import { test } from './csp.ts';
import { commandBar, openShell, ROUTES } from './fixtures.ts';
import { COCKPIT, STATUS } from './incident-helpers.ts';

// Acme as the seed makes it, so the list below is the registry the owner gets on the page.
const SEEDED = {
  'docs/payments-api': { name: 'Payments API docs', product: 'docs' },
  'docs/new-docs': { name: 'New docs', product: 'docs' },
  'docs/partner-api': { name: 'Partner API docs', product: 'docs' },
  'status/acme-status': { name: 'Acme status', product: 'status' },
} as const;

const REGISTRY = [...places('acme', SEEDED), startIncidentCommand('acme')];

// Where an entry's target hands over. The one product with a single project goes straight to
// it, and starting an incident passes through its own URL on the way to the cockpit, so that
// URL is only ever seen for a moment.
const LANDS_ON: Readonly<Record<string, string>> = {
  '/acme/status': STATUS,
  [startIncidentCommand('acme').href]: COCKPIT,
};

const rowText = (entry: Command) => `${entry.name}, ${entry.kind}`;

const open = async (page: Page, path: string) => {
  await openShell(page, path);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(commandBar(page).getByRole('combobox')).toBeFocused();
};

test('the bar offers the whole registry', async ({ page }) => {
  await open(page, ROUTES.overview);
  const rows = (await commandBar(page).getByRole('option').allInnerTexts()).map((text) =>
    text.split('\n').join(''),
  );
  expect(rows).toHaveLength(REGISTRY.length);
  for (const entry of REGISTRY) {
    expect(
      rows.some((row) => row.includes(rowText(entry))),
      entry.id,
    ).toBe(true);
  }
});

for (const entry of REGISTRY) {
  test(`${entry.name} runs from the keyboard alone`, async ({ page }) => {
    await open(page, entry.href === '/account' ? ROUTES.overview : '/account');
    await page.keyboard.type(entry.name);
    const options = commandBar(page).getByRole('option');
    await expect(options.filter({ hasText: rowText(entry) })).toHaveCount(1);
    // Typing lights the first row. Other rows can hold the name too, so it walks to the right
    // one as a person would.
    const active = commandBar(page).locator('[role="option"][data-focused]');
    await expect(active).toHaveCount(1);
    const keys = await options.evaluateAll((rows) => rows.map((row) => row.dataset['key']));
    const target = keys.indexOf(entry.id);
    expect(target, keys.join(', ')).toBeGreaterThanOrEqual(0);
    let row = keys.indexOf((await active.getAttribute('data-key')) ?? '');
    while (row !== target) {
      row = (row + 1) % keys.length;
      await page.keyboard.press('ArrowDown');
      await expect(options.nth(row)).toHaveAttribute('data-focused', 'true');
    }
    await page.keyboard.press('Enter');
    await expect(commandBar(page)).toBeHidden();
    const path = LANDS_ON[entry.href] ?? entry.href;
    await expect.poll(() => new URL(page.url()).pathname).toBe(path);
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
  });
}
