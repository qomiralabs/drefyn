import type { FeatureKey } from '@drefyn/entitlements';
import type { OrganizationId, ProjectId } from '@drefyn/tenancy';
import type { FlagConfig } from './config.ts';
import type { FlagRegistry, NameOf, PlanNameOf } from './definitions.ts';
import { notImplemented } from './errors.ts';
import type { Flags } from './registry.ts';

export interface FlagContext {
  // The targeting key, so a fractional rollout keeps an organization in or out.
  readonly organizationId: OrganizationId;
  readonly projectId?: ProjectId;
  readonly userId?: string;
  // Internal organizations, for the rollout ladder.
  readonly internal?: boolean;
}

export type FlagSource = 'provider' | 'safe_value' | 'test_override' | 'entitlements';

export type FlagEvaluationErrorCode =
  | 'FLAG_TIMEOUT'
  | 'FLAG_PROVIDER_NOT_READY'
  | 'FLAG_NOT_FOUND'
  | 'FLAG_PARSE_ERROR'
  | 'FLAG_GENERAL';

export interface FlagEvaluation {
  readonly value: boolean;
  readonly source: FlagSource;
  readonly errorCode?: FlagEvaluationErrorCode;
}

export interface FlagClient<R extends FlagRegistry = Flags> {
  // Plan flags are left out: ask entitlements, or use evaluate to see the source.
  isOn(name: Exclude<NameOf<R>, PlanNameOf<R>>, ctx: FlagContext): Promise<boolean>;
  evaluate(name: NameOf<R>, ctx: FlagContext): Promise<FlagEvaluation>;
  close(): Promise<void>;
}

// What plan flags read. The caller adapts its tier lookup plus hasFeature to this.
export interface EntitlementsReader {
  hasFeature(organizationId: OrganizationId, feature: FeatureKey): Promise<boolean>;
}

export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface FlagLogger {
  warn(event: string, fields?: LogFields): void;
}

export type MetricLabels = Readonly<Record<string, string>>;

export interface FlagMetrics {
  gauge(
    name: 'flags_provider_ready' | 'flags_last_sync_age_seconds',
    value: number,
    labels?: MetricLabels,
  ): void;
  histogram(name: 'flags_evaluation_ms', value: number, labels?: MetricLabels): void;
}

export interface FlagClientDeps<R extends FlagRegistry = Flags> {
  readonly entitlements: EntitlementsReader;
  // Defaults to the package registry; tests pass their own.
  readonly registry?: R;
  readonly logger?: FlagLogger;
  readonly metrics?: FlagMetrics;
}

export function createFlagClient<const R extends FlagRegistry = Flags>(
  config: FlagConfig,
  deps: FlagClientDeps<R>,
): Promise<FlagClient<R>> {
  return notImplemented('createFlagClient', config, deps);
}
