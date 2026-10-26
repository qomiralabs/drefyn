import type { FeatureKey } from '@drefyn/entitlements';

export const FLAG_KINDS = Object.freeze(['release', 'plan', 'kill_switch', 'experiment'] as const);
export type FlagKind = (typeof FLAG_KINDS)[number];

export const FLAG_AREAS = Object.freeze([
  'product',
  'content',
  'docs',
  'studio',
  'status',
  'site',
  'search',
  'retrieval',
  'ai',
  'auth',
  'email',
  'billing',
  'github',
] as const);
export type FlagArea = (typeof FLAG_AREAS)[number];

export type IsoDate = `${number}-${number}-${number}`;

interface BaseDefinition {
  // <area>.<feature>, lower snake case after the dot.
  readonly name: `${FlagArea}.${string}`;
  readonly kind: FlagKind;
  // GitHub login of the person who removes the flag.
  readonly owner: string;
  readonly description: string;
  readonly created: IsoDate;
  readonly removeBy: IsoDate;
}

// false by type, so no definition can make a release flag fail open.
export interface ReleaseFlag extends BaseDefinition {
  readonly kind: 'release';
  readonly safeValue: false;
}

// Named for what it keeps running: on means running, off means stopped.
export interface KillSwitch extends BaseDefinition {
  readonly kind: 'kill_switch';
  readonly safeValue: boolean;
}

// Resolved through entitlements, never through the provider.
export interface PlanFlag extends BaseDefinition {
  readonly kind: 'plan';
  readonly feature: FeatureKey;
}

export interface ExperimentFlag extends BaseDefinition {
  readonly kind: 'experiment';
  readonly safeValue: false;
  readonly metric: string;
}

export type FlagDefinition = ReleaseFlag | KillSwitch | PlanFlag | ExperimentFlag;
export type FlagRegistry = readonly FlagDefinition[];

export type NameOf<R extends FlagRegistry> = R[number]['name'];
export type PlanNameOf<R extends FlagRegistry> = Extract<R[number], { kind: 'plan' }>['name'];

// Stub: returns the input unchecked. The implementation validates and freezes it.
export function defineFlags<const R extends FlagRegistry>(definitions: R): R {
  return definitions;
}
