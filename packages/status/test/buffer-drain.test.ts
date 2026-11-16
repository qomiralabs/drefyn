import { describe, expect, it } from 'vitest';
import { evaluate, type CurrentState, type RegionReport } from '../src/index.ts';
import { INTERVAL, LONG_AGO, NONE, regions, rule } from './support/fixtures.ts';
import { LatestTable, rng, type Result } from './support/latest.ts';

const TRIALS = 2_000;
const cfg = rule({ mode: 'apply' });

interface Send {
  at: number;
  results: Result[];
}

// One primary outage: probes keep checking and buffer everything. The target has a real down
// run inside the outage that ends before the outage does, so by the time the buffers drain
// nothing current says down. Probes then drain oldest first in small batches, with new live
// results queued behind the old ones.
function trial(seed: number) {
  const random = rng(seed);
  const between = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const names = regions(between(3, 6));
  const drainStart = 2_000_000_000_000;
  const outageStart = drainStart - between(20, 90) * INTERVAL;
  // The run ends early enough that every down result is stale on probe time at drain start.
  const runEnd = drainStart - cfg.freshnessMs - between(1, 5) * INTERVAL;
  const runStart = Math.max(outageStart, runEnd - between(5, 30) * INTERVAL);

  const sends: Send[] = [];
  for (const region of names) {
    const offset = between(0, INTERVAL - 1);
    const queue: Result[] = [];
    // Everything up to a few minutes after the drain begins, oldest first.
    for (let at = outageStart + offset; at < drainStart + 5 * INTERVAL; at += INTERVAL) {
      queue.push({
        probeId: `probe-${region}`,
        region,
        monitorId: 'm1',
        scheduledAt: at,
        receivedAt: 0,
        outcome: at >= runStart && at < runEnd ? 'down' : 'up',
      });
    }
    let clock = drainStart + between(0, 5_000);
    while (queue.length > 0) {
      // A live result is not sent before it was checked.
      const ready = queue.filter((r) => r.scheduledAt <= clock).length;
      const batch = queue.splice(0, Math.min(between(1, 10), Math.max(ready, 1)));
      const at = Math.max(clock, batch.at(-1)?.scheduledAt ?? clock);
      sends.push({ at, results: batch.map((r) => ({ ...r, receivedAt: at })) });
      clock = at + between(500, 5_000);
    }
  }
  sends.sort((a, b) => a.at - b.at);
  return { sends, outageStart };
}

// Runs the drain through the latest table and the rule, applying every change it asks for.
function flipsDuring(seed: number, view: (r: RegionReport) => RegionReport): number {
  const { sends, outageStart } = trial(seed);
  const table = new LatestTable();
  // Before the outage every region had settled on up.
  for (const region of regions(6)) {
    table.upsert({
      probeId: `probe-${region}`,
      region,
      monitorId: 'm1',
      scheduledAt: outageStart - INTERVAL,
      receivedAt: outageStart - INTERVAL,
      outcome: 'up',
    });
  }
  let current: CurrentState = { state: 'operational', since: LONG_AGO };
  let flips = 0;
  for (const send of sends) {
    for (const result of send.results) table.upsert(result);
    const decision = evaluate(cfg, table.reports().map(view), NONE, current, send.at, false);
    if (decision.kind !== 'no_change') {
      flips++;
      current = { state: decision.to, since: send.at };
    }
  }
  return flips;
}

describe('a probe buffer drained oldest first after an outage', () => {
  it(`gives no flip in ${String(TRIALS)} trials`, () => {
    let flipped = 0;
    for (let seed = 1; seed <= TRIALS; seed++) {
      if (flipsDuring(seed, (r) => r) > 0) flipped++;
    }
    expect(flipped).toBe(0);
  });

  it('would flip if freshness read the server clock alone', () => {
    // What a rule that trusted receivedAt alone would see: every drained result looks live.
    const receivedOnly = (r: RegionReport): RegionReport => ({ ...r, scheduledAt: r.receivedAt });
    let flipped = 0;
    for (let seed = 1; seed <= TRIALS; seed++) {
      if (flipsDuring(seed, receivedOnly) > 0) flipped++;
    }
    expect(flipped).toBeGreaterThan(TRIALS * 0.9);
  });
});
