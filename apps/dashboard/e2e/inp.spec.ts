import { expect, type BrowserContext, type Page } from '@playwright/test';
import { commandBar, openShell, products, ROUTES } from './fixtures.ts';
import { readInp, recordInp, slowCpu, watchInp, type InpReading } from './inp.ts';
import { describeInp, summarize } from './inp-summary.ts';
import { test } from './test.ts';
import { archive, openPages, select, toastRegion } from './undo-helpers.ts';

const BUDGET_MS = 200;
const SAMPLES = 7;

// Each scenario gets a fresh page, ready and quiet, then the part that is timed.
interface Scenario {
  readonly name: string;
  readonly ready: (page: Page) => Promise<void>;
  readonly act: (page: Page) => Promise<void>;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'switcher',
    ready: (page) => openShell(page, ROUTES.project),
    act: async (page) => {
      await products(page)
        .getByRole('link', { name: /^Status/ })
        .click();
      await page.waitForURL(/\/acme\/status/);
    },
  },
  {
    name: 'command-bar',
    ready: (page) => openShell(page, ROUTES.overview),
    act: async (page) => {
      await page.keyboard.press('ControlOrMeta+k');
      await expect(commandBar(page)).toBeVisible();
      await page.keyboard.type('pay');
      await expect(commandBar(page).getByRole('option')).toHaveCount(1);
    },
  },
  {
    name: 'choose-a-row',
    ready: openPages,
    act: async (page) => {
      await select(page, 'Refunds');
      await expect(page.getByRole('main').getByRole('status')).toHaveText('1 selected');
    },
  },
  {
    name: 'optimistic-archive',
    ready: async (page) => {
      await openPages(page);
      await select(page, 'Refunds');
      await expect(archive(page)).not.toHaveAttribute('aria-disabled', 'true');
    },
    act: async (page) => {
      await archive(page).click();
      await expect(toastRegion(page).getByText('Archived Refunds.')).toBeVisible();
    },
  },
];

async function sample(context: BrowserContext, scenario: Scenario): Promise<InpReading> {
  const page = await context.newPage();
  await scenario.ready(page);
  await page.waitForLoadState('networkidle');
  await watchInp(page);
  await slowCpu(page);
  await scenario.act(page);
  const reading = await readInp(page);
  await page.close();
  return reading;
}

for (const scenario of SCENARIOS) {
  test(`${scenario.name} responds under ${String(BUDGET_MS)} ms on a slowed CPU`, async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const readings: InpReading[] = [];
    for (let i = 0; i < SAMPLES; i += 1) readings.push(await sample(context, scenario));
    const summary = summarize(
      scenario.name,
      readings.map((r) => r.value),
    );
    console.log(describeInp(summary));
    recordInp(summary, readings);
    expect(summary.median, `median of ${String(SAMPLES)} samples`).toBeLessThan(BUDGET_MS);
  });
}

// Proves the probe sees a slow press. A reading stuck at zero would pass every test above.
test('a handler that blocks for 300 ms reads over budget', async ({ page }) => {
  await openShell(page, ROUTES.overview);
  await page.waitForLoadState('networkidle');
  await watchInp(page);
  await page.evaluate(() => {
    document.getElementById('main')?.addEventListener('click', () => {
      const until = performance.now() + 300;
      while (performance.now() < until);
    });
  });
  await page.getByRole('main').click({ position: { x: 4, y: 4 } });
  expect((await readInp(page)).value).toBeGreaterThan(BUDGET_MS);
});
