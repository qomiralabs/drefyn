import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import lighthouse from 'lighthouse';
import {
  FIRST_RESPONSE_FAIL_BYTES,
  FIRST_RESPONSE_WARN_BYTES,
  firstResponseVerdict,
  jsProblem,
  LIGHTHOUSE_CATEGORIES,
  lighthouseProblems,
  type Scores,
} from './budgets.ts';
import { PAGES, url } from './fixtures.ts';

const DEBUG_PORT = 9334;
const REPORTS = fileURLToPath(new URL('../test-results/lighthouse/', import.meta.url));
const gzip = (body: Buffer | string) => gzipSync(body, { level: 9 }).length;

// Which element Lighthouse timed and the priority each image loaded at, so a page that meets
// the LCP budget by timing something else says so in the log.
function lcpElement(lhr: { audits: Record<string, { details?: unknown }> }): string {
  const breakdown = lhr.audits['lcp-breakdown-insight']?.details as
    { items?: { type?: string; selector?: string }[] } | undefined;
  const node = breakdown?.items?.find((item) => item.type === 'node');
  const requests = lhr.audits['network-requests']?.details as
    { items?: { url?: string; resourceType?: string; priority?: string }[] } | undefined;
  const images = (requests?.items ?? [])
    .filter((r) => r.resourceType === 'Image')
    .map((r) => `${new URL(r.url ?? '', 'http://x').pathname} ${r.priority ?? 'unknown'}`);
  return `${node?.selector ?? 'an unknown element'}${images.length > 0 ? `, images ${images.join(', ')}` : ''}`;
}

// The project runs one test at a time, since a score is noise when a neighbour shares the
// CPU. Not serial: one page over budget must not hide the pages after it.
test.describe.configure({ mode: 'default' });

test.describe('Lighthouse mobile', () => {
  let context: BrowserContext;
  let profile: string;

  test.beforeAll(async () => {
    profile = mkdtempSync(join(tmpdir(), 'site-lighthouse-'));
    context = await chromium.launchPersistentContext(profile, {
      args: [`--remote-debugging-port=${String(DEBUG_PORT)}`],
    });
    mkdirSync(REPORTS, { recursive: true });
  });

  test.afterAll(async () => {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  });

  for (const target of PAGES) {
    test(`${target.id} lighthouse meets the ${target.surface} budget`, async () => {
      test.setTimeout(120_000);
      // The default config: mobile form factor and simulated slow 4G with a 4x slower CPU.
      const result = await lighthouse(url(target), {
        port: DEBUG_PORT,
        logLevel: 'error',
        output: 'json',
        onlyCategories: [...LIGHTHOUSE_CATEGORIES],
      });
      if (result === undefined) throw new Error(`Lighthouse gave no result for ${target.id}`);
      const { lhr, report } = result;
      writeFileSync(join(REPORTS, `${target.id}.json`), String(report));
      expect(lhr.runtimeError, 'Lighthouse ran').toBeUndefined();

      const scores = Object.fromEntries(
        LIGHTHOUSE_CATEGORIES.map((c) => {
          const score = lhr.categories[c]?.score;
          return [c, score === null || score === undefined ? null : Math.round(score * 100)];
        }),
      ) as unknown as Scores;
      const lcp = lhr.audits['largest-contentful-paint']?.numericValue ?? Number.NaN;
      const failing = Object.values(lhr.audits)
        .filter((audit) => audit.score !== null && audit.score < 1)
        .map((audit) => audit.id);
      console.log(
        `lighthouse ${target.id}: ${LIGHTHOUSE_CATEGORIES.map((c) => `${c} ${String(scores[c])}`).join(', ')}, LCP ${String(Math.round(lcp))} ms on ${lcpElement(lhr)}`,
      );
      expect(
        lighthouseProblems(target.surface, scores, lcp),
        `failing audits: ${failing.join(', ')}`,
      ).toEqual([]);
    });
  }
});

for (const target of PAGES) {
  // Counted from what the browser received, so a stale build report cannot hide a script.
  test(`${target.id} loads its JS budget or less in the browser`, async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pending: Promise<number>[] = [];
    page.on('response', (res) => {
      if (res.request().resourceType() === 'script') pending.push(res.body().then(gzip));
    });
    await page.goto(url(target));
    await page.waitForLoadState('networkidle');
    const inline = await page.evaluate(() =>
      [...document.scripts].filter((s) => s.src === '').map((s) => s.text),
    );
    const external = await Promise.all(pending);
    await context.close();
    // The theme line counts, as the renderer counts it.
    expect(inline.length, 'the inline theme line').toBeGreaterThan(0);
    const total = [...external, ...inline.map(gzip)].reduce((sum, n) => sum + n, 0);
    console.log(
      `js ${target.id}: ${String(total)} gzipped bytes in ${String(external.length + inline.length)} scripts`,
    );
    expect(jsProblem(target.surface, total)).toBeUndefined();
  });
}

const statusPages = PAGES.filter((p) => p.surface === 'status');

test('the largest incident fixture is the heaviest status page', async ({ request }) => {
  const sizes = await Promise.all(
    statusPages.map(async (p) => ({ p, bytes: gzip(await (await request.get(url(p))).body()) })),
  );
  const largest = sizes.filter((s) => s.p.largestIncident);
  expect(largest, 'one largest incident fixture').toHaveLength(1);
  const heaviest = Math.max(...sizes.map((s) => s.bytes));
  expect(largest[0]?.bytes).toBe(heaviest);
});

for (const target of statusPages) {
  test(`${target.id} first response fits the round trip budget`, async ({ page }) => {
    const response = await page.goto(url(target));
    if (response === null) throw new Error('no response');
    const bytes = gzip(await response.body());
    const verdict = firstResponseVerdict(bytes);
    console.log(`first response ${target.id}: ${String(bytes)} gzipped bytes, ${verdict}`);
    if (verdict === 'warn') {
      const message = `${target.id} first response is ${String(bytes)} gzipped bytes, over the ${String(FIRST_RESPONSE_WARN_BYTES)} target`;
      test.info().annotations.push({ type: 'warning', description: message });
      // A workflow command, so the warning shows on the PR without failing it.
      console.log(`::warning title=status first response::${message}`);
    }
    expect(bytes, `fails at ${String(FIRST_RESPONSE_FAIL_BYTES)}`).toBeLessThan(
      FIRST_RESPONSE_FAIL_BYTES,
    );
  });
}
