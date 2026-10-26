import { idOf, type IdOf, type OrganizationId, type OrganizationRef } from '@drefyn/tenancy';
import { entryAmount, type Credits } from './amounts.ts';
import { CreditError } from './errors.ts';

export const ENTRY_KINDS = Object.freeze(['grant', 'spend', 'reversal', 'expiry'] as const);
// AI work only. Sends are capped per plan elsewhere and never draw on this pool.
export const SPEND_REASONS = Object.freeze([
  'generation',
  'translation_draft',
  'incident_draft',
] as const);

export type EntryKind = (typeof ENTRY_KINDS)[number];
export type SpendReason = (typeof SPEND_REASONS)[number];
export type CreditEntryId = IdOf<'crd'>;

interface EntryBase {
  readonly id: CreditEntryId;
  readonly organizationId: OrganizationId;
  readonly amount: Credits;
  readonly idempotencyKey: string;
}

export type CreditEntry =
  | (EntryBase & { readonly kind: 'grant' })
  | (EntryBase & { readonly kind: 'spend'; readonly reason: SpendReason })
  | (EntryBase & { readonly kind: 'reversal'; readonly reverses: CreditEntryId })
  | (EntryBase & { readonly kind: 'expiry' });

export type CreditOutcome =
  | { readonly status: 'applied'; readonly entry: CreditEntry }
  | { readonly status: 'insufficient'; readonly requested: Credits; readonly available: Credits };

// Each method checks and appends in one call, so a store backed by a database can make it
// one statement or one locked transaction and never split the check from the write.
export interface CreditLedger {
  balance(ref: OrganizationRef): Promise<Credits>;
  entries(ref: OrganizationRef): Promise<readonly CreditEntry[]>;
  grant(
    ref: OrganizationRef,
    request: { idempotencyKey: string; amount: Credits },
  ): Promise<{ readonly status: 'applied'; readonly entry: CreditEntry }>;
  spend(
    ref: OrganizationRef,
    request: { idempotencyKey: string; amount: Credits; reason: SpendReason },
  ): Promise<CreditOutcome>;
  expire(
    ref: OrganizationRef,
    request: { idempotencyKey: string; amount: Credits },
  ): Promise<CreditOutcome>;
  reverse(
    ref: OrganizationRef,
    request: { idempotencyKey: string; entryId: CreditEntryId },
  ): Promise<{ readonly status: 'applied'; readonly entry: CreditEntry }>;
}

// Matches a Postgres text column limit counted with length(), which counts code points.
const MAX_KEY_CODE_POINTS = 200;

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

// Own properties only, read once: an inherited value is not part of the request, and a
// getter read twice could pass validation and then change.
function own(target: object, name: string): unknown {
  return Object.hasOwn(target, name) ? (target as Record<string, unknown>)[name] : undefined;
}

export function organizationOf(ref: unknown): OrganizationId {
  if (!isObject(ref) || !Object.hasOwn(ref, 'organizationId')) {
    throw new CreditError('CREDIT_ORGANIZATION_INVALID');
  }
  const value = own(ref, 'organizationId');
  if (typeof value !== 'string') throw new CreditError('CREDIT_ORGANIZATION_INVALID');
  try {
    return idOf('org', value);
  } catch {
    throw new CreditError('CREDIT_ORGANIZATION_INVALID');
  }
}

// The key is checked before the body, so a request that is not an object fails on its key.
export function keyOf(request: unknown): { request: object; key: string } {
  if (!isObject(request)) throw new CreditError('CREDIT_KEY_INVALID');
  const key = own(request, 'idempotencyKey');
  if (
    typeof key !== 'string' ||
    key.length === 0 ||
    key.length > MAX_KEY_CODE_POINTS * 2 ||
    !key.isWellFormed() ||
    key.includes('\u0000') ||
    Array.from(key).length > MAX_KEY_CODE_POINTS
  ) {
    throw new CreditError('CREDIT_KEY_INVALID');
  }
  return { request, key };
}

export function amountOf(request: object): Credits {
  return entryAmount(own(request, 'amount'));
}

export function reasonOf(request: object): SpendReason {
  const reason = own(request, 'reason');
  const match = SPEND_REASONS.find((known) => known === reason);
  if (match === undefined) throw new CreditError('CREDIT_REASON_INVALID');
  return match;
}

// A malformed target can never name an entry, so it resolves to nothing like an unknown one.
export function entryIdOf(request: object): CreditEntryId | undefined {
  const value = own(request, 'entryId');
  if (typeof value !== 'string') return undefined;
  try {
    return idOf('crd', value);
  } catch {
    return undefined;
  }
}
