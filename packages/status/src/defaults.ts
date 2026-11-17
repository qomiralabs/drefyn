import { StatusError } from './errors.ts';
import type { CheckOutcome, ControlResult, DownState, RuleConfig, RuleKind } from './types.ts';

// The four status flags as booleans, read by the caller from the flag client. Each one is
// off in production, and off is the safe reading of every field.
export interface StatusFlags {
  // Kill switch: off turns every rule into propose only.
  readonly autoStateChanges: boolean;
  // Off is observe mode: the control result is kept and logged and changes no outcome.
  readonly controlChecks: boolean;
  // Off keeps the vote floor at two regions for new monitors.
  readonly majorityDefault: boolean;
  // Off makes new rules propose instead of apply.
  readonly autoApplyDefault: boolean;
}

export const SAFE_STATUS_FLAGS: StatusFlags = Object.freeze({
  autoStateChanges: false,
  controlChecks: false,
  majorityDefault: false,
  autoApplyDefault: false,
});

// A day is far past any check interval and keeps twice the interval a safe integer.
const MAX_INTERVAL_MS = 86_400_000;

function assertCount(value: number, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new StatusError('STATUS_INPUT_INVALID');
  }
}

// For new monitors only. A stored rule keeps its own minRegions whatever this returns later.
export function defaultMinRegions(
  assigned: number,
  singleRegionOptIn: boolean,
  flags: Pick<StatusFlags, 'majorityDefault'> = SAFE_STATUS_FLAGS,
): number {
  assertCount(assigned, 0);
  if (singleRegionOptIn) return 1;
  if (!flags.majorityDefault) return 2;
  return Math.max(2, Math.ceil(assigned / 2));
}

// The outcome ingest stores. With control checks off the control result is kept beside the
// outcome and never changes it.
export function applyControl(
  outcome: CheckOutcome,
  control: ControlResult | undefined,
  flags: Pick<StatusFlags, 'controlChecks'>,
): CheckOutcome {
  return flags.controlChecks && control === 'failed' ? 'error' : outcome;
}

export interface NewRuleInput {
  readonly intervalMs: number;
  readonly assignedRegions: number;
  readonly singleRegionOptIn?: boolean;
  readonly kind?: RuleKind;
  readonly threshold?: number;
  readonly downState?: DownState;
}

// Freshness and dwell are two intervals; agreement is one, which is two consecutive checks.
export function newRuleConfig(
  input: NewRuleInput,
  flags: Pick<StatusFlags, 'majorityDefault' | 'autoApplyDefault'> = SAFE_STATUS_FLAGS,
): RuleConfig {
  assertCount(input.intervalMs, 1, MAX_INTERVAL_MS);
  const kind = input.kind ?? 'any_down';
  const threshold = input.threshold;
  if (kind === 'threshold') assertCount(threshold ?? 0, 1);
  else if (threshold !== undefined) throw new StatusError('STATUS_INPUT_INVALID');
  const singleRegionOptIn = input.singleRegionOptIn ?? false;
  return {
    kind,
    ...(threshold === undefined ? {} : { threshold }),
    minRegions: defaultMinRegions(input.assignedRegions, singleRegionOptIn, flags),
    singleRegionOptIn,
    freshnessMs: 2 * input.intervalMs,
    minDwellMs: 2 * input.intervalMs,
    minAgreementMs: input.intervalMs,
    mode: flags.autoApplyDefault ? 'apply' : 'propose',
    downState: input.downState ?? 'major_outage',
  };
}

// The value the engine takes for killSwitchAutoOff.
export function autoStateChangesOff(flags: Pick<StatusFlags, 'autoStateChanges'>): boolean {
  return !flags.autoStateChanges;
}
