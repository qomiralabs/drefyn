import type { CheckOutcome, ControlResult, RegionReport, RuleConfig } from '../../src/index.ts';

export const INTERVAL = 60_000;
export const NOW = 1_800_000_000_000;
// Settled long before any test window, so dwell never gets in the way unless a test asks.
export const LONG_AGO = NOW - 30 * 24 * 3_600_000;

export function rule(overrides: Partial<RuleConfig> = {}): RuleConfig {
  return {
    kind: 'any_down',
    minRegions: 2,
    singleRegionOptIn: false,
    freshnessMs: 2 * INTERVAL,
    minDwellMs: 2 * INTERVAL,
    minAgreementMs: INTERVAL,
    mode: 'apply',
    downState: 'major_outage',
    ...overrides,
  };
}

export interface ReportInput {
  region: string;
  outcome: CheckOutcome;
  monitorId?: string;
  probeId?: string;
  scheduledAt?: number;
  receivedAt?: number;
  // How many checks in a row have had this outcome, counting this one.
  checks?: number;
  control?: ControlResult;
}

// A report fresh on both clocks, with the outcome held for the given number of checks.
export function report(input: ReportInput): RegionReport {
  const scheduledAt = input.scheduledAt ?? NOW - 1_000;
  const checks = input.checks ?? 2;
  return {
    probeId: input.probeId ?? `probe-${input.region}`,
    region: input.region,
    monitorId: input.monitorId ?? 'm1',
    receivedAt: input.receivedAt ?? scheduledAt + 500,
    scheduledAt,
    outcomeSince: scheduledAt - (checks - 1) * INTERVAL,
    outcome: input.outcome,
    ...(input.control === undefined ? {} : { control: input.control }),
  };
}

export const regions = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `region-${String(i + 1)}`);

export const NONE: ReadonlySet<string> = new Set();
