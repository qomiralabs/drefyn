import { describe, expect, it } from 'vitest';
import { evaluate, voteFloor, type CurrentState, type RegionReport } from '../src/index.ts';
import { INTERVAL, LONG_AGO, NONE, NOW, regions, report, rule } from './support/fixtures.ts';

const operational: CurrentState = { state: 'operational', since: LONG_AGO };
const down: CurrentState = { state: 'major_outage', since: LONG_AGO };

const allSay = (outcome: RegionReport['outcome'], count: number, checks = 2) =>
  regions(count).map((region) => report({ region, outcome, checks }));

describe('evaluate', () => {
  it('applies a down change when two regions hold down for two checks', () => {
    const decision = evaluate(rule(), allSay('down', 2), NONE, operational, NOW, false);
    expect(decision).toEqual({
      kind: 'apply',
      from: 'operational',
      to: 'major_outage',
      evidence: [
        {
          probeId: 'probe-region-1',
          region: 'region-1',
          monitorId: 'm1',
          scheduledAt: NOW - 1_000,
          outcome: 'down',
        },
        {
          probeId: 'probe-region-2',
          region: 'region-2',
          monitorId: 'm1',
          scheduledAt: NOW - 1_000,
          outcome: 'down',
        },
      ],
    });
  });

  it('recovers only when two regions hold up', () => {
    expect(evaluate(rule(), allSay('up', 2), NONE, down, NOW, false)).toMatchObject({
      kind: 'apply',
      from: 'major_outage',
      to: 'operational',
    });
    expect(evaluate(rule(), allSay('up', 1), NONE, down, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'insufficient_regions',
    });
  });

  it('proposes when the rule is set to propose', () => {
    const decision = evaluate(
      rule({ mode: 'propose' }),
      allSay('down', 3),
      NONE,
      operational,
      NOW,
      false,
    );
    expect(decision.kind).toBe('propose');
  });

  it('turns apply into propose when the kill switch is on', () => {
    const decision = evaluate(rule(), allSay('down', 3), NONE, operational, NOW, true);
    expect(decision).toMatchObject({ kind: 'propose', to: 'major_outage' });
  });

  it('moves to the configured down state', () => {
    const decision = evaluate(
      rule({ downState: 'partial_outage' }),
      allSay('down', 2),
      NONE,
      operational,
      NOW,
      false,
    );
    expect(decision).toMatchObject({ to: 'partial_outage' });
  });

  it('holds state during maintenance whatever the reports say', () => {
    const decision = evaluate(
      rule(),
      allSay('down', 6),
      NONE,
      { state: 'under_maintenance', since: LONG_AGO },
      NOW,
      false,
    );
    expect(decision).toEqual({ kind: 'no_change', reason: 'maintenance' });
  });

  it('says agrees when the regions confirm the current state', () => {
    expect(evaluate(rule(), allSay('up', 3), NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'agrees',
    });
    expect(evaluate(rule(), allSay('down', 3), NONE, down, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'agrees',
    });
  });

  it('waits out dwell after a recent change', () => {
    const recent: CurrentState = { state: 'operational', since: NOW - INTERVAL };
    expect(evaluate(rule(), allSay('down', 3), NONE, recent, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'dwell',
    });
    const exactly: CurrentState = { state: 'operational', since: NOW - 2 * INTERVAL };
    expect(evaluate(rule(), allSay('down', 3), NONE, exactly, NOW, false).kind).toBe('apply');
  });

  it('treats a NaN since as inside dwell', () => {
    const broken: CurrentState = { state: 'operational', since: Number.NaN };
    expect(evaluate(rule(), allSay('down', 3), NONE, broken, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'dwell',
    });
  });

  it('needs agreement across two checks, not one', () => {
    expect(evaluate(rule(), allSay('down', 3, 1), NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'agreement',
    });
    expect(evaluate(rule(), allSay('up', 3, 1), NONE, down, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'agreement',
    });
  });

  it('counts agreement exactly at minAgreementMs', () => {
    const reports = regions(2).map((region) => ({
      ...report({ region, outcome: 'down' }),
      outcomeSince: NOW - 1_000 - INTERVAL + 1,
    }));
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'agreement',
    });
  });

  it('says not_fresh when enough regions are known but too few are fresh', () => {
    const old = NOW - 3 * INTERVAL;
    const reports = [
      report({ region: 'a', outcome: 'down', scheduledAt: old }),
      report({ region: 'b', outcome: 'down', scheduledAt: old }),
      report({ region: 'c', outcome: 'down' }),
    ];
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'not_fresh',
    });
  });

  it('keeps a report exactly at the freshness edge on both clocks', () => {
    const edge = NOW - 2 * INTERVAL;
    const reports = regions(2).map((region) =>
      report({ region, outcome: 'down', scheduledAt: edge, receivedAt: edge }),
    );
    expect(evaluate(rule(), reports, NONE, operational, NOW, false).kind).toBe('apply');
    const late = reports.map((r) => ({ ...r, receivedAt: edge - 1 }));
    expect(evaluate(rule(), late, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'not_fresh',
    });
  });

  it('does not count a report fresh on receivedAt but stale on scheduledAt', () => {
    const reports = regions(3).map((region) =>
      report({ region, outcome: 'down', scheduledAt: NOW - 10 * INTERVAL, receivedAt: NOW }),
    );
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'not_fresh',
    });
  });

  it('reads NaN timestamps as stale', () => {
    const reports = regions(3).map((region) => ({
      ...report({ region, outcome: 'down' }),
      receivedAt: Number.NaN,
    }));
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'not_fresh',
    });
  });

  it('never counts a quarantined region', () => {
    const quarantined = new Set(['region-2', 'region-3']);
    expect(evaluate(rule(), allSay('down', 3), quarantined, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'insufficient_regions',
    });
  });

  it('counts a region once however many probes it has', () => {
    const reports = ['p1', 'p2', 'p3'].map((probeId) =>
      report({ region: 'only', outcome: 'down', probeId }),
    );
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'insufficient_regions',
    });
  });

  it('keeps the newest report per region and monitor', () => {
    const reports = [
      report({ region: 'a', outcome: 'down', scheduledAt: NOW - 30_000 }),
      report({ region: 'a', outcome: 'up', scheduledAt: NOW - 1_000, probeId: 'p2' }),
      report({ region: 'b', outcome: 'down' }),
    ];
    // Region a now says up, so only one region votes down and no quorum forms.
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'insufficient_regions',
    });
  });

  it('orders by probe time before server time', () => {
    // The newer check arrived first; it still wins.
    const older = report({
      region: 'a',
      outcome: 'down',
      scheduledAt: NOW - 30_000,
      receivedAt: NOW - 100,
    });
    const newer = report({
      region: 'a',
      outcome: 'up',
      scheduledAt: NOW - 20_000,
      receivedAt: NOW - 15_000,
    });
    const b = report({ region: 'b', outcome: 'down' });
    for (const order of [
      [older, newer, b],
      [newer, older, b],
    ]) {
      expect(evaluate(rule(), order, NONE, operational, NOW, false)).toEqual({
        kind: 'no_change',
        reason: 'insufficient_regions',
      });
    }
  });

  it('breaks ties on receivedAt, then outcomeSince, then probe', () => {
    const a = report({ region: 'a', outcome: 'down' });
    const b = report({ region: 'b', outcome: 'down' });
    // Each time the down report wins on the field under test and would lose on probe text.
    const earlierReceipt = { ...a, outcome: 'up' as const, receivedAt: a.receivedAt - 1 };
    for (const order of [
      [a, earlierReceipt, b],
      [earlierReceipt, a, b],
    ]) {
      expect(evaluate(rule(), order, NONE, operational, NOW, false).kind).toBe('apply');
    }
    const earlierRun = { ...a, outcome: 'up' as const, outcomeSince: a.outcomeSince - 1 };
    for (const order of [
      [a, earlierRun, b],
      [earlierRun, a, b],
    ]) {
      expect(evaluate(rule(), order, NONE, operational, NOW, false).kind).toBe('apply');
    }
    const otherProbe = { ...a, outcome: 'up' as const, probeId: 'zz' };
    for (const order of [
      [a, otherProbe, b],
      [otherProbe, a, b],
    ]) {
      expect(evaluate(rule(), order, NONE, operational, NOW, false).kind).toBe('no_change');
    }
    const sameProbeOtherOutcome = { ...a, outcome: 'up' as const };
    for (const order of [
      [a, sameProbeOtherOutcome, b],
      [sameProbeOtherOutcome, a, b],
    ]) {
      expect(evaluate(rule(), order, NONE, operational, NOW, false).kind).toBe('no_change');
    }
    const withControl = { ...a, control: 'ok' as const };
    expect(evaluate(rule(), [a, withControl, b], NONE, operational, NOW, false)).toEqual(
      evaluate(rule(), [withControl, a, b], NONE, operational, NOW, false),
    );
  });

  it('counts degraded as healthy and a plain error as no vote', () => {
    const reports = [
      report({ region: 'a', outcome: 'degraded' }),
      report({ region: 'b', outcome: 'degraded' }),
    ];
    expect(evaluate(rule(), reports, NONE, down, NOW, false)).toMatchObject({
      kind: 'apply',
      to: 'operational',
    });
    const errors = allSay('error', 3);
    expect(evaluate(rule(), errors, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'insufficient_regions',
    });
  });

  it('holds state with control_failed when the fleet cannot reach its controls', () => {
    const reports = regions(3).map((region) =>
      report({ region, outcome: 'error', control: 'failed' }),
    );
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'control_failed',
    });
    expect(evaluate(rule(), reports, NONE, down, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'control_failed',
    });
  });

  it('says control_failed when failed controls are why no quorum forms', () => {
    const reports = [
      report({ region: 'a', outcome: 'down' }),
      report({ region: 'b', outcome: 'up' }),
      report({ region: 'c', outcome: 'error', control: 'failed' }),
    ];
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'control_failed',
    });
  });

  it('still lets regions with working controls decide', () => {
    const reports = [
      report({ region: 'a', outcome: 'down', control: 'ok' }),
      report({ region: 'b', outcome: 'down', control: 'ok' }),
      report({ region: 'c', outcome: 'error', control: 'failed' }),
    ];
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toMatchObject({
      kind: 'apply',
      to: 'major_outage',
    });
  });

  it('treats a down outcome with a failed control as a vote, as observe mode stores it', () => {
    const reports = regions(2).map((region) =>
      report({ region, outcome: 'down', control: 'failed' }),
    );
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toMatchObject({
      kind: 'apply',
    });
  });

  it('lets down win when both quorums form', () => {
    const reports = [
      ...allSay('down', 2),
      ...regions(4).map((r) => report({ region: `${r}-up`, outcome: 'up' })),
    ];
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toMatchObject({
      to: 'major_outage',
    });
    expect(evaluate(rule(), reports, NONE, down, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'agrees',
    });
  });

  it('holds when held votes point the other way from loose ones', () => {
    // Two fresh first checks say down, two settled regions say up.
    const reports = [
      report({ region: 'a', outcome: 'down', checks: 1 }),
      report({ region: 'b', outcome: 'down', checks: 1 }),
      report({ region: 'c', outcome: 'up' }),
      report({ region: 'd', outcome: 'up' }),
    ];
    expect(evaluate(rule(), reports, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'agreement',
    });
  });

  it('moves a hand set state to the rule outcome', () => {
    const degraded: CurrentState = { state: 'degraded_performance', since: LONG_AGO };
    expect(evaluate(rule(), allSay('down', 2), NONE, degraded, NOW, false)).toMatchObject({
      from: 'degraded_performance',
      to: 'major_outage',
    });
    expect(evaluate(rule(), allSay('up', 2), NONE, degraded, NOW, false)).toMatchObject({
      to: 'operational',
    });
  });

  describe('rule kinds over several monitors', () => {
    const monitors = ['m1', 'm2', 'm3'];
    const regionSays = (region: string, downs: number, checks = 2) =>
      monitors.map((monitorId, i) =>
        report({ region, monitorId, outcome: i < downs ? 'down' : 'up', checks }),
      );
    const both = (downs: number) => [...regionSays('a', downs), ...regionSays('b', downs)];

    it('any_down fires on one monitor and recovers only when all are up', () => {
      expect(evaluate(rule(), both(1), NONE, operational, NOW, false).kind).toBe('apply');
      expect(evaluate(rule(), both(1), NONE, down, NOW, false)).toEqual({
        kind: 'no_change',
        reason: 'agrees',
      });
      expect(evaluate(rule(), both(0), NONE, down, NOW, false).kind).toBe('apply');
    });

    it('all_down fires only when every monitor is down', () => {
      const cfg = rule({ kind: 'all_down' });
      expect(evaluate(cfg, both(2), NONE, operational, NOW, false)).toEqual({
        kind: 'no_change',
        reason: 'agrees',
      });
      expect(evaluate(cfg, both(3), NONE, operational, NOW, false).kind).toBe('apply');
      expect(evaluate(cfg, both(2), NONE, down, NOW, false).kind).toBe('apply');
    });

    it('threshold fires at the threshold', () => {
      const cfg = rule({ kind: 'threshold', threshold: 2 });
      expect(evaluate(cfg, both(1), NONE, operational, NOW, false)).toEqual({
        kind: 'no_change',
        reason: 'agrees',
      });
      expect(evaluate(cfg, both(2), NONE, operational, NOW, false).kind).toBe('apply');
    });

    it('any_down ignores a stray threshold', () => {
      const cfg = rule({ kind: 'any_down', threshold: 3 });
      expect(evaluate(cfg, both(1), NONE, operational, NOW, false).kind).toBe('apply');
    });

    it('threshold without a value acts like any_down', () => {
      const cfg = rule({ kind: 'threshold' });
      expect(evaluate(cfg, both(1), NONE, operational, NOW, false).kind).toBe('apply');
    });

    it('a region with an unseen monitor does not vote up under any_down', () => {
      const partial = [
        ...regionSays('a', 0).slice(0, 2),
        ...regionSays('b', 0).slice(0, 2),
        report({ region: 'c', monitorId: 'm3', outcome: 'up' }),
      ];
      expect(evaluate(rule(), partial, NONE, down, NOW, false)).toEqual({
        kind: 'no_change',
        reason: 'insufficient_regions',
      });
    });

    it('a threshold above the monitor count never recovers on errors alone', () => {
      const cfg = rule({ kind: 'threshold', threshold: 5 });
      const errors = [...regions(3)].flatMap((region) =>
        monitors.map((monitorId) => report({ region, monitorId, outcome: 'error' })),
      );
      expect(evaluate(cfg, errors, NONE, down, NOW, false)).toEqual({
        kind: 'no_change',
        reason: 'insufficient_regions',
      });
    });

    it('takes evidence only from regions whose held vote it was', () => {
      // Region c has one held down and one fresh down: a loose down vote, not a held one.
      const cfg = rule({ kind: 'threshold', threshold: 2 });
      const reports = [
        ...regionSays('a', 2),
        ...regionSays('b', 2),
        report({ region: 'c', monitorId: 'm1', outcome: 'down' }),
        report({ region: 'c', monitorId: 'm2', outcome: 'down', checks: 1 }),
        report({ region: 'c', monitorId: 'm3', outcome: 'up' }),
      ];
      const decision = evaluate(cfg, reports, NONE, operational, NOW, false);
      expect(decision.kind === 'apply' ? decision.evidence.map((e) => e.region) : []).toEqual([
        'a',
        'a',
        'b',
        'b',
      ]);
    });

    it('leaves down reports out of recovery evidence', () => {
      const cfg = rule({ kind: 'all_down' });
      const decision = evaluate(cfg, both(1), NONE, down, NOW, false);
      expect(decision.kind === 'apply' ? decision.evidence.map((e) => e.outcome) : []).toEqual([
        'up',
        'up',
        'up',
        'up',
      ]);
    });

    it('sorts evidence by region, then monitor, whatever the report order', () => {
      const reports = [...regionSays('b', 3), ...regionSays('a', 3)].reverse();
      const decision = evaluate(rule(), reports, NONE, operational, NOW, false);
      expect(
        decision.kind === 'apply' ? decision.evidence.map((e) => `${e.region}/${e.monitorId}`) : [],
      ).toEqual(['a/m1', 'a/m2', 'a/m3', 'b/m1', 'b/m2', 'b/m3']);
    });

    it('lists only held, supporting reports as evidence', () => {
      const reports = [
        ...regionSays('a', 1),
        ...regionSays('b', 1),
        report({ region: 'c', monitorId: 'm1', outcome: 'down', checks: 1 }),
      ];
      const decision = evaluate(rule(), reports, NONE, operational, NOW, false);
      expect(decision.kind === 'apply' ? decision.evidence : []).toEqual([
        expect.objectContaining({ region: 'a', monitorId: 'm1', outcome: 'down' }),
        expect.objectContaining({ region: 'b', monitorId: 'm1', outcome: 'down' }),
      ]);
      const recovery = evaluate(rule(), both(0), NONE, down, NOW, false);
      expect(recovery.kind === 'apply' ? recovery.evidence.length : 0).toBe(6);
    });
  });
});

describe('voteFloor', () => {
  it('is never under two without the opt in, and one with it', () => {
    expect(voteFloor({ minRegions: 1, singleRegionOptIn: false })).toBe(2);
    expect(voteFloor({ minRegions: 0, singleRegionOptIn: true })).toBe(1);
    expect(voteFloor({ minRegions: 4, singleRegionOptIn: false })).toBe(4);
  });

  it('lets one region decide only with the opt in', () => {
    const one = [report({ region: 'a', outcome: 'down' })];
    expect(evaluate(rule({ minRegions: 1 }), one, NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'insufficient_regions',
    });
    expect(
      evaluate(rule({ minRegions: 1, singleRegionOptIn: true }), one, NONE, operational, NOW, false)
        .kind,
    ).toBe('apply');
  });
});
