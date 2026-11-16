// Budget: p99 under 1 ms per component. The run fails if either shape goes over, though the
// figure depends on the machine, so CI does not run it.
import { expect, test } from 'vitest';
import { evaluate, type RegionReport } from '../src/index.ts';
import { LONG_AGO, NONE, NOW, regions, report, rule } from './support/fixtures.ts';

const run = evaluate;
const cfg = rule({ mode: 'propose' });
const current = { state: 'operational' as const, since: LONG_AGO };

// Mixed outcomes, so every branch of the tally runs.
function shape(monitors: number): RegionReport[] {
  const out: RegionReport[] = [];
  for (const [r, region] of regions(6).entries()) {
    for (let m = 0; m < monitors; m++) {
      const outcome = (m + r) % 7 === 0 ? 'down' : (m + r) % 11 === 0 ? 'error' : 'up';
      out.push(report({ region, monitorId: `m${String(m)}`, outcome, checks: 1 + ((m + r) % 3) }));
    }
  }
  return out;
}

const oneMonitor = shape(1);
const manyMonitors = shape(200);

test('evaluate per component', async ({ bench }) => {
  const result = await bench.compare(
    bench('6 regions, 1 monitor', () => {
      run(cfg, oneMonitor, NONE, current, NOW, false);
    }),
    bench('6 regions, 200 monitors', () => {
      run(cfg, manyMonitors, NONE, current, NOW, false);
    }),
    { iterations: 20_000, time: 0, warmupIterations: 2_000 },
  );
  for (const name of ['6 regions, 1 monitor', '6 regions, 200 monitors'] as const) {
    expect(result.get(name).latency.p99, name).toBeLessThan(1);
  }
});
