import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  COMPONENT_STATES,
  DOWN_STATES,
  evaluate,
  voteFloor,
  type DownState,
  type CurrentState,
  type Decision,
  type RegionReport,
  type RuleConfig,
} from '../src/index.ts';
import { INTERVAL, LONG_AGO, NONE, NOW, regions, report, rule } from './support/fixtures.ts';
import { LatestTable } from './support/latest.ts';

const REGIONS = regions(8);
const MONITORS = ['m1', 'm2', 'm3'];
const PROBES = ['p1', 'p2', 'p3'];
const RUNS = { numRuns: 300 };

const cfgArb: fc.Arbitrary<RuleConfig> = fc
  .record({
    kind: fc.constantFrom('any_down', 'all_down', 'threshold'),
    threshold: fc.integer({ min: 1, max: 3 }),
    minRegions: fc.integer({ min: 0, max: 5 }),
    singleRegionOptIn: fc.boolean(),
    mode: fc.constantFrom('apply', 'propose'),
    downState: fc.constantFrom(...DOWN_STATES),
  })
  .map(({ kind, threshold, ...rest }) =>
    rule(kind === 'threshold' ? { kind, threshold, ...rest } : { kind, ...rest }),
  );

// Times reach well outside the freshness window and agreement span on purpose.
const reportArb = (regionPool: readonly string[]): fc.Arbitrary<RegionReport> =>
  fc
    .record({
      region: fc.constantFrom(...regionPool),
      monitorId: fc.constantFrom(...MONITORS),
      probeId: fc.constantFrom(...PROBES),
      scheduledAgo: fc.integer({ min: -30_000, max: 5 * INTERVAL }),
      receivedLag: fc.integer({ min: 0, max: 4 * INTERVAL }),
      heldFor: fc.integer({ min: 0, max: 4 * INTERVAL }),
      outcome: fc.constantFrom('up', 'down', 'degraded', 'error'),
      control: fc.constantFrom(undefined, 'ok', 'failed'),
    })
    .map((r) => {
      const scheduledAt = NOW - r.scheduledAgo;
      return {
        probeId: r.probeId,
        region: r.region,
        monitorId: r.monitorId,
        scheduledAt,
        receivedAt: Math.min(NOW, scheduledAt + r.receivedLag),
        outcomeSince: scheduledAt - r.heldFor,
        outcome: r.outcome,
        ...(r.control === undefined ? {} : { control: r.control }),
      } satisfies RegionReport;
    });

const reportsArb = fc.array(reportArb(REGIONS), { maxLength: 40 });
const stateArb = fc.constantFrom(...COMPONENT_STATES.filter((s) => s !== 'under_maintenance'));
const currentArb: fc.Arbitrary<CurrentState> = fc.record({
  state: stateArb,
  since: fc.integer({ min: LONG_AGO, max: NOW }),
});
const quarantineArb = fc.subarray(REGIONS).map((list) => new Set(list));

const isChange = (d: Decision) => d.kind !== 'no_change';
const summary = (d: Decision) =>
  d.kind === 'no_change' ? `no_change:${d.reason}` : `${d.kind}:${d.from}>${d.to}`;

// Down votes, held for the given number of checks, from the first count regions.
const downFrom = (count: number, checks = 2, monitorId = 'm1') =>
  regions(count).map((region) => report({ region, outcome: 'down', checks, monitorId }));

describe('evaluate properties', () => {
  it('maintenance: under maintenance nothing changes', () => {
    fc.assert(
      fc.property(cfgArb, reportsArb, quarantineArb, fc.boolean(), (cfg, reports, q, kill) => {
        const current = { state: 'under_maintenance' as const, since: LONG_AGO };
        expect(evaluate(cfg, reports, q, current, NOW, kill)).toEqual({
          kind: 'no_change',
          reason: 'maintenance',
        });
      }),
      RUNS,
    );
  });

  it('insufficient_regions: fewer known regions than the floor never change state', () => {
    // Regions 6 to 8 are quarantined and report anything at all.
    const quarantined = new Set(REGIONS.slice(5));
    const caseArb = cfgArb.chain((cfg) => {
      const pool = REGIONS.slice(0, Math.min(voteFloor(cfg) - 1, 5));
      const own =
        pool.length === 0 ? fc.constant([]) : fc.array(reportArb(pool), { maxLength: 20 });
      return fc.tuple(fc.constant(cfg), own);
    });
    fc.assert(
      fc.property(
        caseArb,
        fc.array(reportArb(REGIONS.slice(5)), { maxLength: 10 }),
        currentArb,
        fc.boolean(),
        ([cfg, own], noise, current, kill) => {
          const decision = evaluate(cfg, [...own, ...noise], quarantined, current, NOW, kill);
          expect(decision).toEqual({ kind: 'no_change', reason: 'insufficient_regions' });
        },
      ),
      RUNS,
    );
  });

  it('insufficient_regions: one region alone never changes state without the opt in', () => {
    fc.assert(
      fc.property(
        cfgArb.map((c) => ({ ...c, singleRegionOptIn: false })),
        fc.array(reportArb(['solo']), { maxLength: 30 }),
        currentArb,
        fc.boolean(),
        (cfg, reports, current, kill) => {
          expect(isChange(evaluate(cfg, reports, NONE, current, NOW, kill))).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('not_fresh: enough regions known, too few fresh on both clocks', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 1 }),
        fc.constantFrom('scheduled', 'received', 'both'),
        fc.integer({ min: 1, max: 10 * INTERVAL }),
        currentArb,
        (count, freshCount, stale, by, current) => {
          const tooOld = NOW - 2 * INTERVAL - by;
          const reports = regions(count).map((region, i) => {
            const r = report({ region, outcome: 'down' });
            if (i < freshCount) return r;
            return {
              ...r,
              scheduledAt: stale === 'received' ? r.scheduledAt : tooOld,
              outcomeSince: tooOld - INTERVAL,
              receivedAt: stale === 'scheduled' ? NOW : tooOld,
            };
          });
          expect(evaluate(rule(), reports, NONE, current, NOW, false)).toEqual({
            kind: 'no_change',
            reason: 'not_fresh',
          });
        },
      ),
      RUNS,
    );
  });

  it('a report stale on scheduledAt but fresh on receivedAt never votes', () => {
    fc.assert(
      fc.property(
        cfgArb,
        reportsArb,
        fc.integer({ min: 1, max: 60 * INTERVAL }),
        currentArb,
        fc.boolean(),
        (cfg, reports, by, current, kill) => {
          const drained = reports.map((r) => ({
            ...r,
            scheduledAt: NOW - cfg.freshnessMs - by,
            outcomeSince: NOW - cfg.freshnessMs - by - 10 * INTERVAL,
            receivedAt: NOW,
          }));
          // None of these can vote, so the result is as if they were not fresh at all.
          const decision = evaluate(cfg, drained, NONE, current, NOW, kill);
          expect(isChange(decision)).toBe(false);
        },
      ),
      RUNS,
    );
  });

  it('dwell: a change inside minDwellMs of the last one waits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 2 * INTERVAL - 1 }),
        fc.constantFrom(...DOWN_STATES),
        (count, ago, downState) => {
          const current = { state: 'operational' as const, since: NOW - ago };
          expect(evaluate(rule({ downState }), downFrom(count), NONE, current, NOW, false)).toEqual(
            {
              kind: 'no_change',
              reason: 'dwell',
            },
          );
        },
      ),
      RUNS,
    );
  });

  it('agreement: a long settled state does not change on its first bad check', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 2 * INTERVAL, max: 365 * 24 * 3_600_000 }),
        fc.constantFrom('apply', 'propose'),
        (count, settledFor, mode) => {
          const current = { state: 'operational' as const, since: NOW - settledFor };
          expect(evaluate(rule({ mode }), downFrom(count, 1), NONE, current, NOW, false)).toEqual({
            kind: 'no_change',
            reason: 'agreement',
          });
        },
      ),
      RUNS,
    );
  });

  it('agreement: two consecutive checks are required, and are enough', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 5_000 }),
        fc.boolean(),
        (count, startChecks, lag, recovering) => {
          const table = new LatestTable();
          const before = recovering ? 'down' : 'up';
          const after = recovering ? 'up' : 'down';
          const current: CurrentState = {
            state: recovering ? 'major_outage' : 'operational',
            since: LONG_AGO,
          };
          const t0 = NOW - 10 * INTERVAL;
          const check = (at: number, outcome: 'up' | 'down') => {
            for (const region of regions(count)) {
              table.upsert({
                probeId: `probe-${region}`,
                region,
                monitorId: 'm1',
                scheduledAt: at,
                receivedAt: at + lag,
                outcome,
              });
            }
          };
          for (let i = startChecks; i > 0; i--) check(t0 - i * INTERVAL, before);
          check(t0, after);
          const first = evaluate(rule(), table.reports(), NONE, current, t0 + lag, false);
          expect(first, 'one check').toEqual({ kind: 'no_change', reason: 'agreement' });
          // The first check stays the only evidence until the second one lands.
          const waiting = evaluate(rule(), table.reports(), NONE, current, t0 + INTERVAL, false);
          expect(waiting.kind, 'still one check').toBe('no_change');
          check(t0 + INTERVAL, after);
          const second = evaluate(
            rule(),
            table.reports(),
            NONE,
            current,
            t0 + INTERVAL + lag,
            false,
          );
          expect(second, 'two checks').toMatchObject({
            kind: 'apply',
            to: recovering ? 'operational' : 'major_outage',
          });
        },
      ),
      RUNS,
    );
  });

  it('agrees: every change moves to a different state, and agreement says agrees', () => {
    fc.assert(
      fc.property(
        cfgArb,
        reportsArb,
        quarantineArb,
        currentArb,
        fc.boolean(),
        (cfg, reports, q, current, kill) => {
          const decision = evaluate(cfg, reports, q, current, NOW, kill);
          if (decision.kind !== 'no_change') {
            expect(decision.to).not.toBe(current.state);
            expect(decision.from).toBe(current.state);
            expect(['operational', cfg.downState]).toContain(decision.to);
          }
        },
      ),
      RUNS,
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.constantFrom<'operational' | DownState>('operational', ...DOWN_STATES),
        (count, state) => {
          const outcome = state === 'operational' ? 'up' : 'down';
          const reports = regions(count).map((region) => report({ region, outcome }));
          const cfg = rule({ downState: state === 'operational' ? 'major_outage' : state });
          expect(evaluate(cfg, reports, NONE, { state, since: NOW }, NOW, false)).toEqual({
            kind: 'no_change',
            reason: 'agrees',
          });
        },
      ),
      RUNS,
    );
  });

  it('control_failed: a fleet fault holds state in both directions', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 0, max: 1 }),
        currentArb,
        fc.boolean(),
        (count, voters, current, kill) => {
          const reports = regions(count).map((region, i) =>
            i < voters
              ? report({ region, outcome: 'down' })
              : report({ region, outcome: 'error', control: 'failed' }),
          );
          expect(evaluate(rule(), reports, NONE, current, NOW, kill)).toEqual({
            kind: 'no_change',
            reason: 'control_failed',
          });
        },
      ),
      RUNS,
    );
  });

  it('control_failed: a failed control never counts as a down vote', () => {
    fc.assert(
      fc.property(
        cfgArb,
        reportsArb,
        fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }),
        quarantineArb,
        currentArb,
        (cfg, reports, flips, q, current) => {
          const before = evaluate(cfg, reports, q, current, NOW, false);
          const faulted = reports.map((r, i) =>
            flips[i] === true ? { ...r, outcome: 'error' as const, control: 'failed' as const } : r,
          );
          const after = evaluate(cfg, faulted, q, current, NOW, false);
          if (after.kind !== 'no_change' && after.to === cfg.downState) {
            expect(summary(before)).toBe(summary(after));
          }
        },
      ),
      RUNS,
    );
  });

  it('a region counts once however many probes or reports it has', () => {
    fc.assert(
      fc.property(
        cfgArb,
        reportsArb,
        quarantineArb,
        currentArb,
        fc.array(
          fc.tuple(
            fc.nat(),
            fc.constantFrom(...PROBES),
            fc.integer({ min: 1, max: 10 * INTERVAL }),
          ),
          {
            maxLength: 20,
          },
        ),
        (cfg, reports, q, current, extras) => {
          const base = evaluate(cfg, reports, q, current, NOW, false);
          const more: RegionReport[] = [...reports];
          for (const [index, probeId, older] of extras) {
            const source = reports[index % Math.max(1, reports.length)];
            if (source === undefined) continue;
            // The same check seen through another probe in the region, and an older one.
            more.push({ ...source, probeId: `${source.probeId}-copy-${probeId}` });
            more.push({
              ...source,
              outcome: source.outcome === 'down' ? 'up' : 'down',
              scheduledAt: source.scheduledAt - older,
              receivedAt: source.receivedAt - older,
            });
          }
          expect(summary(evaluate(cfg, more, q, current, NOW, false))).toBe(summary(base));
        },
      ),
      RUNS,
    );
  });

  it('quarantined regions never count', () => {
    fc.assert(
      fc.property(cfgArb, reportsArb, quarantineArb, currentArb, (cfg, reports, q, current) => {
        const withoutThem = reports.filter((r) => !q.has(r.region));
        const a = evaluate(cfg, reports, q, current, NOW, false);
        const b = evaluate(cfg, withoutThem, q, current, NOW, false);
        // Monitors only quarantined regions reported still count toward all_down, so
        // compare on configs where the monitor set cannot shrink.
        const monitorsKept =
          new Set(withoutThem.map((r) => r.monitorId)).size ===
          new Set(reports.map((r) => r.monitorId)).size;
        if (monitorsKept) expect(summary(a)).toBe(summary(b));
        if (q.size === REGIONS.length) expect(isChange(a)).toBe(false);
      }),
      RUNS,
    );
  });

  it('kill switch: apply only when the rule asks and the switch allows', () => {
    fc.assert(
      fc.property(
        cfgArb,
        reportsArb,
        quarantineArb,
        currentArb,
        fc.boolean(),
        (cfg, reports, q, current, kill) => {
          const decision = evaluate(cfg, reports, q, current, NOW, kill);
          if (decision.kind === 'apply') {
            expect(cfg.mode).toBe('apply');
            expect(kill).toBe(false);
          }
          const switched = evaluate(cfg, reports, q, current, NOW, true);
          expect(switched.kind).not.toBe('apply');
        },
      ),
      RUNS,
    );
  });

  it('is deterministic and ignores report order', () => {
    fc.assert(
      fc.property(
        cfgArb,
        reportsArb,
        quarantineArb,
        currentArb,
        fc.boolean(),
        fc.integer(),
        (cfg, reports, q, current, kill, seed) => {
          const shuffled = fc.sample(fc.shuffledSubarray(reports, { minLength: reports.length }), {
            seed,
            numRuns: 1,
          })[0];
          expect(evaluate(cfg, shuffled ?? reports, q, current, NOW, kill)).toEqual(
            evaluate(cfg, reports, q, current, NOW, kill),
          );
        },
      ),
      RUNS,
    );
  });

  it('every change carries held evidence from at least the floor of regions', () => {
    fc.assert(
      fc.property(cfgArb, reportsArb, quarantineArb, currentArb, (cfg, reports, q, current) => {
        const decision = evaluate(cfg, reports, q, current, NOW, false);
        if (decision.kind === 'no_change') return;
        const voters = new Set(decision.evidence.map((e) => e.region));
        expect(voters.size).toBeGreaterThanOrEqual(voteFloor(cfg));
        for (const e of decision.evidence) expect(q.has(e.region)).toBe(false);
      }),
      RUNS,
    );
  });
});
