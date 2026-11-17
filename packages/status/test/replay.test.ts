import { describe, expect, it } from 'vitest';
import {
  evaluate,
  type CheckOutcome,
  type ControlResult,
  type CurrentState,
} from '../src/index.ts';
import { INTERVAL, NONE, regions, rule } from './support/fixtures.ts';
import { LatestTable, rng, type Result } from './support/latest.ts';

// Synthetic noise with no real outage in it, so every change is a false flip. Rates are the
// assumed ones the design was modelled on, not measured fleet data.
const DAY = 24 * 3_600_000;
const WEEK = 7 * DAY;
const TICK = 30_000;
const FLAKE = 0.002;
const REGION_FAULT_EVERY = 14 * DAY;
const REGION_FAULT_MAX = 15 * 60_000;
const FLEET_FAULT_EVERY = 180 * DAY;
const FLEET_FAULT_MAX = 6 * 60_000;
const START = 2_000_000_000_000;

interface Window {
  from: number;
  to: number;
}

interface Week {
  // Per region, the checks the probe made: scheduled time and what it saw of the target.
  checks: {
    region: string;
    scheduledAt: number;
    receivedAt: number;
    reachable: boolean;
    fleet: boolean;
  }[];
}

function faults(random: () => number, every: number, max: number, forced: boolean): Window[] {
  const out: Window[] = [];
  if (forced) {
    const from = START + Math.floor(random() * (WEEK - max));
    out.push({ from, to: from + max });
  }
  // Poisson arrivals over the week.
  let at = START;
  for (;;) {
    at += -Math.log(1 - random()) * every;
    if (at >= START + WEEK) break;
    out.push({ from: at, to: at + 60_000 + random() * (max - 60_000) });
  }
  return out;
}

const inside = (windows: readonly Window[], at: number) =>
  windows.some((w) => at >= w.from && at < w.to);

function week(seed: number, regionCount: number, stress: boolean): Week {
  const random = rng(seed);
  const fleet = faults(random, FLEET_FAULT_EVERY, FLEET_FAULT_MAX, stress);
  const checks: Week['checks'] = [];
  for (const [index, region] of regions(regionCount).entries()) {
    const own = faults(random, REGION_FAULT_EVERY, REGION_FAULT_MAX, stress);
    for (let at = START + index * 7_000; at < START + WEEK; at += INTERVAL) {
      const flake = random() < FLAKE;
      const inFleetFault = inside(fleet, at);
      checks.push({
        region,
        scheduledAt: at,
        receivedAt: at + 200 + Math.floor(random() * 2_800),
        reachable: !flake && !inFleetFault && !inside(own, at),
        fleet: inFleetFault,
      });
    }
  }
  checks.sort((a, b) => a.receivedAt - b.receivedAt);
  return { checks };
}

// A perfect control catches every fleet fault and nothing else.
function outcomeOf(
  check: Week['checks'][number],
  control: boolean,
): Pick<Result, 'outcome' | 'control'> {
  if (control && check.fleet)
    return { outcome: 'error', control: 'failed' satisfies ControlResult };
  const outcome: CheckOutcome = check.reachable ? 'up' : 'down';
  return control ? { outcome, control: 'ok' } : { outcome };
}

function falseFlips(
  seed: number,
  regionCount: number,
  minRegions: number,
  stress: boolean,
  control: boolean,
) {
  const cfg = rule({ minRegions, mode: 'apply' });
  const { checks } = week(seed, regionCount, stress);
  const table = new LatestTable();
  let current: CurrentState = { state: 'operational', since: START - DAY };
  let next = 0;
  let flips = 0;
  for (let now = START + TICK; now < START + WEEK; now += TICK) {
    for (; next < checks.length; next++) {
      const check = checks[next];
      if (check === undefined || check.receivedAt > now) break;
      table.upsert({
        probeId: `probe-${check.region}`,
        region: check.region,
        monitorId: 'm1',
        scheduledAt: check.scheduledAt,
        receivedAt: check.receivedAt,
        ...outcomeOf(check, control),
      });
    }
    const decision = evaluate(cfg, table.reports(), NONE, current, now, false);
    if (decision.kind !== 'no_change') {
      flips++;
      current = { state: decision.to, since: now };
    }
  }
  return flips;
}

const SHAPES = [
  { name: '2 of 3', regions: 3, min: 2 },
  { name: '2 of 6', regions: 6, min: 2 },
  { name: '3 of 6', regions: 6, min: 3 },
] as const;
const SEEDS = [1, 2, 3, 4];

// Synchronous and heavy under coverage on shared runners: each case gets a wide timeout.
const SLOW = { timeout: 120_000 };
const CASES = SHAPES.flatMap((shape) => SEEDS.map((seed) => ({ ...shape, seed })));

describe('a replayed week of synthetic noise', () => {
  it.each(CASES)(
    'gives no false flip at $name, seed $seed, with a perfect control',
    SLOW,
    ({ regions: n, min, seed }) => {
      expect(falseFlips(seed, n, min, false, true), 'noise week').toBe(0);
      expect(falseFlips(seed, n, min, true, true), 'stress week').toBe(0);
    },
  );

  // Not proof of anything: without a control a fleet fault fails every region at once, and
  // agreement cannot tell that from an outage. These counts are the residual to watch in beta.
  // Each forced fleet fault costs two flips, down and back; seed 1 draws a second one.
  const PINNED_STRESS: Readonly<Record<number, number>> = { 1: 4, 2: 2, 3: 2, 4: 2 };
  it.each(CASES)(
    'flips with no control at $name, seed $seed, and the count is pinned',
    SLOW,
    ({ regions: n, min, seed }) => {
      expect(falseFlips(seed, n, min, false, false), 'noise week').toBe(0);
      expect(falseFlips(seed, n, min, true, false), 'stress week').toBe(PINNED_STRESS[seed]);
    },
  );
});
