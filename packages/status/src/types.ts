// Plain strings for now: the engine compares them and never parses them. Branded ids arrive
// with the table the reports are read from.
export type ProbeId = string;
export type RegionId = string;
export type MonitorId = string;

export const COMPONENT_STATES = Object.freeze([
  'operational',
  'degraded_performance',
  'partial_outage',
  'major_outage',
  'under_maintenance',
] as const);
export type ComponentState = (typeof COMPONENT_STATES)[number];

export const DOWN_STATES = Object.freeze([
  'degraded_performance',
  'partial_outage',
  'major_outage',
] as const);
export type DownState = (typeof DOWN_STATES)[number];

export type CheckOutcome = 'up' | 'down' | 'degraded' | 'error';
export type ControlResult = 'ok' | 'failed';

// The newest result one probe sent for one monitor, as the rule worker reads it.
export interface RegionReport {
  readonly probeId: ProbeId;
  // From the probe's key registration, never from the result body.
  readonly region: RegionId;
  readonly monitorId: MonitorId;
  // Server time, epoch ms.
  readonly receivedAt: number;
  // Probe time, epoch ms. Has to be fresh too, or a draining buffer looks live.
  readonly scheduledAt: number;
  // scheduledAt of the first check with the current outcome.
  readonly outcomeSince: number;
  readonly outcome: CheckOutcome;
  // Absent from probes that run no control check.
  readonly control?: ControlResult;
}

export const RULE_KINDS = Object.freeze(['any_down', 'all_down', 'threshold'] as const);
export type RuleKind = (typeof RULE_KINDS)[number];

export interface RuleConfig {
  readonly kind: RuleKind;
  // Monitors that must be down, only for kind threshold.
  readonly threshold?: number;
  readonly minRegions: number;
  readonly singleRegionOptIn: boolean;
  readonly freshnessMs: number;
  // How long the component must stay in a state before it can leave it.
  readonly minDwellMs: number;
  // How long each voting region must have held its outcome, measured on probe time.
  readonly minAgreementMs: number;
  readonly mode: 'apply' | 'propose';
  readonly downState: DownState;
}

export interface CurrentState {
  readonly state: ComponentState;
  readonly since: number;
}

export interface ReportRef {
  readonly probeId: ProbeId;
  readonly region: RegionId;
  readonly monitorId: MonitorId;
  readonly scheduledAt: number;
  readonly outcome: CheckOutcome;
}

export const NO_CHANGE_REASONS = Object.freeze([
  'insufficient_regions',
  'not_fresh',
  'dwell',
  'agreement',
  'maintenance',
  'agrees',
  'control_failed',
] as const);
export type NoChangeReason = (typeof NO_CHANGE_REASONS)[number];

export type Decision =
  | { readonly kind: 'no_change'; readonly reason: NoChangeReason }
  | {
      readonly kind: 'propose' | 'apply';
      readonly from: ComponentState;
      readonly to: ComponentState;
      readonly evidence: readonly ReportRef[];
    };
