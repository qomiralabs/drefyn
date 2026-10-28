import { FEATURE_KEYS, type FeatureKey } from '@drefyn/entitlements';
import { FlagError, type DefinitionProblem } from './errors.ts';

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
  'dashboard',
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

const NAME = /^[a-z]+\.[a-z][a-z0-9_]*$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const AREAS: ReadonlySet<string> = new Set(FLAG_AREAS);
const KINDS: ReadonlySet<string> = new Set(FLAG_KINDS);
const FEATURES: ReadonlySet<string> = new Set(FEATURE_KEYS);

function refuse(problem: DefinitionProblem, flag: unknown): never {
  throw new FlagError('FLAG_DEFINITION_INVALID', {
    problem,
    ...(typeof flag === 'string' ? { flag } : {}),
  });
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// A real calendar day. Date.UTC rolls 2026-02-30 over to March, so the round trip catches it.
function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DAY.exec(value);
  if (match === null) return false;
  const [, y, m, d] = match.map(Number);
  if (y === undefined || m === undefined || d === undefined) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function check(input: unknown): void {
  if (typeof input !== 'object' || input === null) refuse('name_pattern', undefined);
  const def = input as Record<string, unknown>;
  const name = def['name'];
  if (typeof name !== 'string' || !NAME.test(name)) refuse('name_pattern', name);
  if (!AREAS.has(name.slice(0, name.indexOf('.')))) refuse('unknown_area', name);
  const kind = def['kind'];
  if (typeof kind !== 'string' || !KINDS.has(kind)) refuse('unknown_kind', name);
  if (!isText(def['owner'])) refuse('owner_missing', name);

  const created = def['created'];
  const removeBy = def['removeBy'];
  if (!isDay(created)) refuse('date_invalid', name);
  const datedKind = kind === 'release' || kind === 'experiment';
  if (removeBy === undefined || removeBy === null) {
    if (datedKind) refuse('remove_by_missing', name);
  } else {
    if (!isDay(removeBy)) refuse('date_invalid', name);
    // Both are zero padded real days here, so text order is date order.
    if (datedKind && removeBy <= created) refuse('remove_by_not_after_created', name);
  }

  const safeValue = def['safeValue'];
  if (kind === 'release' || kind === 'experiment') {
    if (safeValue !== false) refuse('safe_value_invalid', name);
  } else if (kind === 'kill_switch') {
    if (typeof safeValue !== 'boolean') refuse('safe_value_invalid', name);
  }
  if (kind === 'experiment' && !isText(def['metric'])) refuse('metric_missing', name);
  if (kind === 'plan') {
    const feature = def['feature'];
    if (typeof feature !== 'string' || !FEATURES.has(feature)) refuse('feature_unknown', name);
  }
}

// Validates at module load and returns a frozen copy, so nothing can flip a safe value later.
export function defineFlags<const R extends FlagRegistry>(definitions: R): R {
  const seen = new Set<string>();
  const out: FlagDefinition[] = [];
  for (const definition of definitions as readonly unknown[]) {
    check(definition);
    const copy = Object.freeze({ ...(definition as FlagDefinition) });
    if (seen.has(copy.name)) refuse('duplicate_name', copy.name);
    seen.add(copy.name);
    out.push(copy);
  }
  return Object.freeze(out) as unknown as R;
}
