import { expect, type BrowserContext, type Page } from '@playwright/test';
import { commandBar, openShell, products, ROUTES } from './fixtures.ts';
import { readInp, recordInp, slowCpu, watchInp, watchPress, type InpReading } from './inp.ts';
import { describeInp, inpLimit, overBudget, summarize } from './inp-summary.ts';
import { test } from './test.ts';
import { archive, openPages, select, toastRegion } from './undo-helpers.ts';

const SAMPLES = 7;
const LIMIT_MS = inpLimit(process.env);

// Each scenario gets a fresh page, ready and quiet. Then the slowdown starts, and whatever a
// person does first happens under it, because work left over from that step is part of what
// the timed press competes with.
interface Scenario {
  readonly name: string;
  readonly ready: (page: Page) => Promise<void>;
  readonly first?: (page: Page) => Promise<void>;
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
    ready: openPages,
    first: (page) => select(page, 'Refunds'),
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
  await scenario.first?.(page);
  await watchPress(page);
  await scenario.act(page);
  const reading = await readInp(page);
  await page.close();
  return reading;
}

for (const scenario of SCENARIOS) {
  test(`${scenario.name} responds under ${String(LIMIT_MS)} ms on a slowed CPU`, async ({
    context,
  }) => {
    test.setTimeout(120_000);
    const readings: InpReading[] = [];
    for (let i = 0; i < SAMPLES; i += 1) readings.push(await sample(context, scenario));
    const session = summarize(
      scenario.name,
      readings.map((r) => r.value),
    );
    const press = summarize(
      `${scenario.name}-press`,
      readings.map((r) => r.press),
    );
    console.log(`${describeInp(session)}\n${describeInp(press)}`);
    for (const miss of [overBudget(session), overBudget(press)]) {
      if (miss !== null) console.warn(miss);
    }
    recordInp(session, readings);
    expect(session.median, `median of ${String(SAMPLES)} samples`).toBeLessThan(LIMIT_MS);
    expect(press.median, `median press of ${String(SAMPLES)} samples`).toBeLessThan(LIMIT_MS);
  });
}

// Proves the probe sees a slow press. A reading stuck at zero would pass every test above.
test('a handler that blocks for 320 ms reads over the limit', async ({ page }) => {
  await openShell(page, ROUTES.overview);
  await page.waitForLoadState('networkidle');
  await watchInp(page);
  await watchPress(page);
  await page.evaluate(() => {
    document.getElementById('main')?.addEventListener('click', () => {
      const until = performance.now() + 320;
      while (performance.now() < until);
    });
  });
  await page.getByRole('main').click({ position: { x: 4, y: 4 } });
  const { value, press } = await readInp(page);
  expect(value).toBeGreaterThan(LIMIT_MS);
  expect(press).toBeGreaterThan(LIMIT_MS);
});
