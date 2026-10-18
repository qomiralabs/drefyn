import { FEATURES, LIMITS, PRODUCTS, TIERS, UNLIMITED } from './table.ts';
import type {
  FeatureKey,
  FeatureRow,
  HostedTier,
  LimitKey,
  LimitRow,
  LimitValue,
  Product,
  Scope,
  Tier,
} from './table.ts';

export { PRODUCTS, TIERS, UNLIMITED };
export type { FeatureKey, HostedTier, LimitKey, LimitValue, Product, Scope, Tier };

export const packageName = '@drefyn/entitlements';

export const LIMIT_KEYS: readonly LimitKey[] = Object.freeze(Object.keys(LIMITS) as LimitKey[]);
export const FEATURE_KEYS: readonly FeatureKey[] = Object.freeze(
  Object.keys(FEATURES) as FeatureKey[],
);

export interface LimitInfo {
  readonly key: LimitKey;
  readonly scope: Scope;
  readonly direction: 'max' | 'min';
  readonly grace: boolean;
}

export interface FeatureInfo {
  readonly feature: FeatureKey;
  readonly scope: Scope;
  readonly since: HostedTier;
  readonly openCore: boolean;
}

export type LimitOverrides = Readonly<Partial<Record<LimitKey, LimitValue>>>;

export interface CheckOptions {
  // Set only by the send meter or notifier once it has decided the send may use grace.
  // A stateless check cannot know when the cap ran out, so it never decides this itself.
  readonly graceEligible?: boolean;
  readonly overrides?: LimitOverrides;
}

interface ResultBase {
  readonly tier: Tier;
  readonly key: LimitKey;
  readonly usage: number;
  readonly limit: LimitValue;
  readonly grace: LimitValue;
}

// Refusals carry read_only so a caller never reads "over the limit" as "delete it".
export type CheckResult =
  | (ResultBase & { readonly status: 'allowed' })
  | (ResultBase & {
      readonly status: 'over_limit';
      readonly limit: number;
      readonly excess: number;
      readonly access: 'read_only';
    })
  | (ResultBase & {
      readonly status: 'not_entitled';
      readonly limit: 0;
      readonly access: 'read_only';
    });

export interface UncalibratedCell {
  readonly tier: HostedTier;
  readonly key: LimitKey;
  readonly value: number;
  readonly basis: 'at_least' | 'at_most' | 'unset';
}

export type EntitlementErrorCode =
  | 'ENTITLEMENT_UNKNOWN_TIER'
  | 'ENTITLEMENT_UNKNOWN_LIMIT'
  | 'ENTITLEMENT_UNKNOWN_FEATURE'
  | 'ENTITLEMENT_UNKNOWN_PRODUCT'
  | 'ENTITLEMENT_INVALID_USAGE'
  | 'ENTITLEMENT_INVALID_OVERRIDE'
  | 'ENTITLEMENT_OVERRIDE_LOWERS_LIMIT';

// Fixed text per code: inputs come from database rows and requests, so a message that
// echoed them could leak into logs and error pages.
const MESSAGES: Readonly<Record<EntitlementErrorCode, string>> = {
  ENTITLEMENT_UNKNOWN_TIER: 'The tier is not a known tier.',
  ENTITLEMENT_UNKNOWN_LIMIT: 'The limit key is not a known limit.',
  ENTITLEMENT_UNKNOWN_FEATURE: 'The feature key is not a known feature.',
  ENTITLEMENT_UNKNOWN_PRODUCT: 'The product is not a known product.',
  ENTITLEMENT_INVALID_USAGE: 'Usage must be a non negative safe integer.',
  ENTITLEMENT_INVALID_OVERRIDE:
    'An override must be a non negative safe integer or the unlimited value.',
  ENTITLEMENT_OVERRIDE_LOWERS_LIMIT: 'An override may only make a limit more generous.',
};

export class EntitlementError extends Error {
  override readonly name = 'EntitlementError';
  readonly code: EntitlementErrorCode;
  // Declared, not initialised, so the property is absent rather than undefined.
  declare readonly limitKey?: LimitKey;

  constructor(code: EntitlementErrorCode, limitKey?: LimitKey) {
    super(MESSAGES[code]);
    this.code = code;
    if (limitKey !== undefined) this.limitKey = limitKey;
  }
}

// Maps, not object lookups, so '__proto__', 'constructor' and friends are never found.
const KNOWN_TIERS = new Map<unknown, Tier>(TIERS.map((tier) => [tier, tier]));

interface ResolvedLimit {
  readonly info: LimitInfo;
  // Placeholders already resolved to the value they stand for today.
  readonly values: Readonly<Record<Tier, LimitValue>>;
}

const LIMIT_TABLE = new Map<unknown, ResolvedLimit>();
const uncalibrated: UncalibratedCell[] = [];
for (const key of LIMIT_KEYS) {
  const row: LimitRow = LIMITS[key];
  const resolve = (tier: HostedTier): LimitValue => {
    const cell = row.cells[tier];
    if (typeof cell !== 'object') return cell;
    uncalibrated.push(Object.freeze({ tier, key, value: cell.value, basis: cell.basis }));
    return cell.value;
  };
  const values: Record<Tier, LimitValue> = {
    free: resolve('free'),
    starter: resolve('starter'),
    growth: resolve('growth'),
    scale: resolve('scale'),
    enterprise: resolve('enterprise'),
    // Typed as UNLIMITED in the table, so a self host never runs on a placeholder.
    self_hosted: row.cells.self_hosted,
  };
  LIMIT_TABLE.set(key, {
    info: Object.freeze({ key, scope: row.scope, direction: row.direction, grace: row.grace }),
    values: Object.freeze(values),
  });
}

// Every cell the plans leave open, with the value it resolves to today and why.
export const UNCALIBRATED: readonly UncalibratedCell[] = Object.freeze(uncalibrated);

// Position on the ladder, cheapest first, read from TIERS so the order lives in one place.
const TIER_RANK = Object.freeze(
  Object.fromEntries(TIERS.map((tier, rank) => [tier, rank])) as Record<Tier, number>,
);

interface ResolvedFeature {
  readonly info: FeatureInfo;
  readonly sinceRank: number;
}

const FEATURE_TABLE = new Map<unknown, ResolvedFeature>(
  FEATURE_KEYS.map((feature) => {
    const row: FeatureRow = FEATURES[feature];
    const info = Object.freeze({
      feature,
      scope: row.scope,
      since: row.since,
      openCore: row.openCore,
    });
    return [feature, { info, sinceRank: TIER_RANK[row.since] }];
  }),
);

function toTier(tier: unknown): Tier {
  const known = KNOWN_TIERS.get(tier);
  if (known === undefined) throw new EntitlementError('ENTITLEMENT_UNKNOWN_TIER');
  return known;
}

function limitEntry(key: unknown): ResolvedLimit {
  const entry = LIMIT_TABLE.get(key);
  if (entry === undefined) throw new EntitlementError('ENTITLEMENT_UNKNOWN_LIMIT');
  return entry;
}

function featureEntry(feature: unknown): ResolvedFeature {
  const entry = FEATURE_TABLE.get(feature);
  if (entry === undefined) throw new EntitlementError('ENTITLEMENT_UNKNOWN_FEATURE');
  return entry;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function toUsage(usage: unknown): number {
  if (!isCount(usage)) throw new EntitlementError('ENTITLEMENT_INVALID_USAGE');
  // Adding 0 turns -0 into 0, so results never carry a negative zero.
  return usage + 0;
}

// UNLIMITED beats any number. For a max limit more is better; for a floor, less is.
function atLeastAsGenerous(direction: 'max' | 'min', a: LimitValue, b: LimitValue): boolean {
  if (a === UNLIMITED) return true;
  if (b === UNLIMITED) return false;
  return direction === 'max' ? a >= b : a <= b;
}

// A Map, array, Date or class instance keeps its entries where Object.keys cannot see
// them, so reading one as "no overrides" would quietly drop a customer's raises. Only a
// plain record, from a literal, JSON or Object.create(null), is accepted.
function isPlainRecord(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const NO_OPTIONS: CheckOptions = Object.freeze({});

function toOptions(options: unknown): CheckOptions {
  if (options === undefined) return NO_OPTIONS;
  if (!isPlainRecord(options)) throw new EntitlementError('ENTITLEMENT_INVALID_OVERRIDE');
  return options;
}

// Checks the whole map on every call, so one bad entry fails every check for that
// organization instead of being silently skipped while the others apply. Every own key
// counts, hidden or symbol keyed too, and only plain data entries are read, so what was
// validated is what applies. Nothing is written back to the caller's object.
function resolveOverrides(tier: Tier, overrides: unknown): ReadonlyMap<LimitKey, LimitValue> {
  const applied = new Map<LimitKey, LimitValue>();
  if (overrides === undefined) return applied;
  if (!isPlainRecord(overrides)) throw new EntitlementError('ENTITLEMENT_INVALID_OVERRIDE');
  for (const name of Reflect.ownKeys(overrides)) {
    const entry = typeof name === 'string' ? LIMIT_TABLE.get(name) : undefined;
    // An unknown name is never attached to the error: it is caller data, not a key.
    if (entry === undefined) throw new EntitlementError('ENTITLEMENT_UNKNOWN_LIMIT');
    const { key, direction } = entry.info;
    const field = Object.getOwnPropertyDescriptor(overrides, name);
    if (field?.enumerable !== true || !('value' in field)) {
      throw new EntitlementError('ENTITLEMENT_INVALID_OVERRIDE', key);
    }
    const raw: unknown = field.value;
    let value: LimitValue;
    if (raw === UNLIMITED) value = UNLIMITED;
    else if (isCount(raw)) value = raw + 0;
    else throw new EntitlementError('ENTITLEMENT_INVALID_OVERRIDE', key);
    // A floor of 0 means no floor at all; a contract has to say that with UNLIMITED, so a
    // stray 0 in a record cannot turn monitors into a request flood.
    if (direction === 'min' && value === 0) {
      throw new EntitlementError('ENTITLEMENT_INVALID_OVERRIDE', key);
    }
    const base = entry.values[tier];
    if (!atLeastAsGenerous(direction, value, base)) {
      throw new EntitlementError('ENTITLEMENT_OVERRIDE_LOWERS_LIMIT', key);
    }
    applied.set(key, value);
  }
  return applied;
}

function effectiveLimit(tier: Tier, entry: ResolvedLimit, overrides: unknown): LimitValue {
  const applied = resolveOverrides(tier, overrides);
  return applied.get(entry.info.key) ?? entry.values[tier];
}

// Exact integer division for non negative safe integers: no fractional intermediate.
function divide(a: number, b: number): number {
  return (a - (a % b)) / b;
}

const GRACE_PERCENT = 25;

// floor(cap * 25 / 100) without forming cap * 25, which leaves the safe integer range
// once a contract raises a cap past about 360 trillion.
function graceOf(cap: number): number {
  const hundreds = divide(cap, 100);
  const rest = cap % 100;
  return hundreds * GRACE_PERCENT + divide(rest * GRACE_PERCENT, 100);
}

function graceFor(info: LimitInfo, limit: LimitValue): LimitValue {
  if (!info.grace) return 0;
  return limit === UNLIMITED ? UNLIMITED : graceOf(limit);
}

export function limitFor(
  tier: Tier,
  key: LimitKey,
  options?: Pick<CheckOptions, 'overrides'>,
): LimitValue {
  const known = toTier(tier);
  const entry = limitEntry(key);
  return effectiveLimit(known, entry, toOptions(options).overrides);
}

export function graceAllowance(
  tier: Tier,
  key: LimitKey,
  options?: Pick<CheckOptions, 'overrides'>,
): LimitValue {
  const known = toTier(tier);
  const entry = limitEntry(key);
  return graceFor(entry.info, effectiveLimit(known, entry, toOptions(options).overrides));
}

// usage is the amount in use with the checked action included: the third project, the
// 2,001st email. The answer is a value for every valid input; only bad input throws.
export function checkLimit(
  tier: Tier,
  key: LimitKey,
  usage: number,
  options?: CheckOptions,
): CheckResult {
  const known = toTier(tier);
  const entry = limitEntry(key);
  const opts = toOptions(options);
  const limit = effectiveLimit(known, entry, opts.overrides);
  const used = toUsage(usage);
  const eligible = opts.graceEligible === true;
  const { info } = entry;

  const base = { tier: known, key: info.key, usage: used };
  if (limit === UNLIMITED) {
    const grace = eligible ? graceFor(info, limit) : 0;
    return Object.freeze({ ...base, limit, grace, status: 'allowed' });
  }

  if (info.direction === 'min') {
    if (used >= limit) return Object.freeze({ ...base, limit, grace: 0, status: 'allowed' });
    return Object.freeze({
      ...base,
      limit,
      grace: 0,
      status: 'over_limit',
      excess: limit - used,
      access: 'read_only',
    });
  }

  const grace = eligible && info.grace ? graceOf(limit) : 0;
  if (limit === 0 && used > 0) {
    return Object.freeze({ ...base, limit, grace, status: 'not_entitled', access: 'read_only' });
  }
  // Compared as a difference so limit + grace never has to fit in a safe integer.
  const over = used - limit;
  if (over <= grace) return Object.freeze({ ...base, limit, grace, status: 'allowed' });
  return Object.freeze({
    ...base,
    limit,
    grace,
    status: 'over_limit',
    excess: over - grace,
    access: 'read_only',
  });
}

export function limitInfo(key: LimitKey): LimitInfo {
  return limitEntry(key).info;
}

export function hasFeature(tier: Tier, feature: FeatureKey): boolean {
  const known = toTier(tier);
  const entry = featureEntry(feature);
  if (known === 'self_hosted') return entry.info.openCore;
  return TIER_RANK[known] >= entry.sinceRank;
}

export function featureInfo(feature: FeatureKey): FeatureInfo {
  return featureEntry(feature).info;
}

export interface ProductEntitlements {
  readonly product: Product;
  readonly checkLimit: typeof checkLimit;
  readonly limitFor: typeof limitFor;
  readonly graceAllowance: typeof graceAllowance;
  readonly hasFeature: typeof hasFeature;
  readonly limitInfo: typeof limitInfo;
  readonly featureInfo: typeof featureInfo;
}

// The same functions for every product, so one plan cannot answer differently in Docs,
// Studio and Status. The product name is there for metrics and log context.
const PRODUCT_APIS = new Map<unknown, ProductEntitlements>(
  PRODUCTS.map((product) => [
    product,
    Object.freeze({
      product,
      checkLimit,
      limitFor,
      graceAllowance,
      hasFeature,
      limitInfo,
      featureInfo,
    }),
  ]),
);

export function entitlementsFor(product: Product): ProductEntitlements {
  const api = PRODUCT_APIS.get(product);
  if (api === undefined) throw new EntitlementError('ENTITLEMENT_UNKNOWN_PRODUCT');
  return api;
}
