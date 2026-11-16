import { describe, expect, it } from 'vitest';
import {
  SAFE_STATUS_FLAGS,
  StatusError,
  applyControl,
  autoStateChangesOff,
  evaluate,
  newRuleConfig,
  parseRuleConfig,
  type StatusFlags,
} from '../src/index.ts';
import { LONG_AGO, NONE, NOW, regions, report } from './support/fixtures.ts';

const off: StatusFlags = SAFE_STATUS_FLAGS;
const on: StatusFlags = {
  autoStateChanges: true,
  controlChecks: true,
  majorityDefault: true,
  autoApplyDefault: true,
};
const operational = { state: 'operational' as const, since: LONG_AGO };

describe('status flags', () => {
  it('are all off in the safe set', () => {
    expect(off).toEqual({
      autoStateChanges: false,
      controlChecks: false,
      majorityDefault: false,
      autoApplyDefault: false,
    });
    expect(Object.isFrozen(off)).toBe(true);
  });
});

describe('newRuleConfig', () => {
  it('proposes while status.auto_apply_default is off, and that is the default', () => {
    expect(newRuleConfig({ intervalMs: 60_000, assignedRegions: 3 }, off).mode).toBe('propose');
    expect(newRuleConfig({ intervalMs: 60_000, assignedRegions: 3 }).mode).toBe('propose');
  });

  it('applies with status.auto_apply_default on', () => {
    expect(newRuleConfig({ intervalMs: 60_000, assignedRegions: 3 }, on).mode).toBe('apply');
  });

  it('sets freshness and dwell to two intervals and agreement to one', () => {
    expect(newRuleConfig({ intervalMs: 30_000, assignedRegions: 6 }, off)).toStrictEqual({
      kind: 'any_down',
      minRegions: 2,
      singleRegionOptIn: false,
      freshnessMs: 60_000,
      minDwellMs: 60_000,
      minAgreementMs: 30_000,
      mode: 'propose',
      downState: 'major_outage',
    });
  });

  it('takes the majority floor for a new monitor with status.majority_default on', () => {
    expect(newRuleConfig({ intervalMs: 60_000, assignedRegions: 6 }, on).minRegions).toBe(3);
  });

  it('keeps kind, threshold, down state and the opt in', () => {
    expect(
      newRuleConfig(
        {
          intervalMs: 60_000,
          assignedRegions: 1,
          singleRegionOptIn: true,
          kind: 'threshold',
          threshold: 2,
          downState: 'partial_outage',
        },
        off,
      ),
    ).toMatchObject({
      kind: 'threshold',
      threshold: 2,
      minRegions: 1,
      downState: 'partial_outage',
    });
  });

  it('refuses bad intervals and thresholds', () => {
    for (const intervalMs of [0, -1, 1.5, Number.NaN, 86_400_001]) {
      expect(() => newRuleConfig({ intervalMs, assignedRegions: 3 })).toThrow(StatusError);
    }
    expect(newRuleConfig({ intervalMs: 86_400_000, assignedRegions: 3 }).freshnessMs).toBe(
      172_800_000,
    );
    expect(() =>
      newRuleConfig({ intervalMs: 60_000, assignedRegions: 3, kind: 'threshold' }),
    ).toThrow(StatusError);
    expect(() =>
      newRuleConfig({ intervalMs: 60_000, assignedRegions: 3, kind: 'any_down', threshold: 2 }),
    ).toThrow(expect.objectContaining({ code: 'STATUS_INPUT_INVALID' }));
    try {
      newRuleConfig({ intervalMs: 0, assignedRegions: 3 });
    } catch (error) {
      expect(error).toMatchObject({
        name: 'StatusError',
        code: 'STATUS_INPUT_INVALID',
        message: 'counts and intervals must be safe integers in range',
      });
    }
  });
});

describe('existing rules when status.majority_default turns on', () => {
  it('keep their values, and still decide on two regions', () => {
    const stored = JSON.parse(
      JSON.stringify(newRuleConfig({ intervalMs: 60_000, assignedRegions: 6 }, off)),
    ) as unknown;
    const rule = parseRuleConfig(stored);
    expect(rule.minRegions).toBe(2);
    // The flag only reaches new rules; a new monitor beside it gets the majority.
    expect(newRuleConfig({ intervalMs: 60_000, assignedRegions: 6 }, on).minRegions).toBe(3);
    const twoDown = regions(2).map((region) => report({ region, outcome: 'down' }));
    expect(evaluate({ ...rule, mode: 'apply' }, twoDown, NONE, operational, NOW, false).kind).toBe(
      'apply',
    );
  });
});

describe('parseRuleConfig', () => {
  const good = newRuleConfig({ intervalMs: 60_000, assignedRegions: 3 }, off);

  it('accepts a stored rule as it is', () => {
    expect(parseRuleConfig(good)).toStrictEqual(good);
    expect(Object.keys(parseRuleConfig(good))).not.toContain('threshold');
    const threshold = { ...good, kind: 'threshold', threshold: 2 };
    expect(parseRuleConfig(threshold)).toEqual(threshold);
    expect(parseRuleConfig({ ...good, minRegions: 1, singleRegionOptIn: true }).minRegions).toBe(1);
  });

  it('refuses anything else with a fixed code', () => {
    const bad: unknown[] = [
      null,
      'rule',
      { ...good, minRegions: 1 },
      { ...good, minRegions: 2.5 },
      { ...good, kind: 'threshold' },
      { ...good, threshold: 2 },
      { ...good, freshnessMs: 0 },
      { ...good, minAgreementMs: -1 },
      { ...good, mode: 'auto' },
      { ...good, downState: 'operational' },
      { ...good, extra: true },
    ];
    for (const input of bad) {
      expect(() => parseRuleConfig(input)).toThrow(
        expect.objectContaining({ code: 'STATUS_RULE_INVALID' }),
      );
    }
  });
});

describe('control checks', () => {
  it('change nothing with status.control_checks off', () => {
    expect(applyControl('down', 'failed', off)).toBe('down');
    expect(applyControl('up', 'failed', off)).toBe('up');
  });

  it('turn a result into error when the control failed with the flag on', () => {
    expect(applyControl('down', 'failed', on)).toBe('error');
    expect(applyControl('up', 'failed', on)).toBe('error');
    expect(applyControl('down', 'ok', on)).toBe('down');
    expect(applyControl('down', undefined, on)).toBe('down');
  });

  it('hold state end to end with the flag on, and vote with it off', () => {
    const results = regions(3).map((region) => ({ region, outcome: 'down' as const }));
    const build = (flags: StatusFlags) =>
      results.map(({ region, outcome }) =>
        report({ region, outcome: applyControl(outcome, 'failed', flags), control: 'failed' }),
      );
    const cfg = newRuleConfig({ intervalMs: 60_000, assignedRegions: 3 }, off);
    expect(evaluate(cfg, build(on), NONE, operational, NOW, false)).toEqual({
      kind: 'no_change',
      reason: 'control_failed',
    });
    expect(evaluate(cfg, build(off), NONE, operational, NOW, false).kind).toBe('propose');
  });
});

describe('kill switch', () => {
  it('maps status.auto_state_changes to the engine argument', () => {
    expect(autoStateChangesOff(off)).toBe(true);
    expect(autoStateChangesOff(on)).toBe(false);
  });

  it('turns apply into propose when the switch is off', () => {
    const cfg = { ...newRuleConfig({ intervalMs: 60_000, assignedRegions: 3 }, on) };
    const reports = regions(3).map((region) => report({ region, outcome: 'down' }));
    expect(cfg.mode).toBe('apply');
    expect(evaluate(cfg, reports, NONE, operational, NOW, autoStateChangesOff(off)).kind).toBe(
      'propose',
    );
    expect(evaluate(cfg, reports, NONE, operational, NOW, autoStateChangesOff(on)).kind).toBe(
      'apply',
    );
  });
});
