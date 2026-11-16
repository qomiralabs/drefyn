import type { OrganizationRef, TenantRef } from '@drefyn/tenancy';
import { credits, entryAmount, type Credits } from './amounts.ts';
import { CreditError } from './errors.ts';
import {
  entryIdOf,
  keyOf,
  organizationOf,
  type CreditEntryId,
  type CreditLedger,
} from './ledger.ts';

// Each operation is also the spend reason it records, so the ledger shows what paid for what.
export const AI_OPERATIONS = Object.freeze(['stale_draft', 'reader_answer'] as const);

export type AiOperation = (typeof AI_OPERATIONS)[number];

export type AiCharge =
  | { readonly status: 'charged'; readonly entryId: CreditEntryId }
  | { readonly status: 'unmetered' }
  | { readonly status: 'refused' };

// Spend first, refund on no answer: whether a turn earned its charge is known only after the
// run, and charging up front keeps a burst from spending credits the pool does not have.
export interface AiBudget {
  charge(
    ref: TenantRef,
    request: { idempotencyKey: string; operation: AiOperation; floor?: Credits },
  ): Promise<AiCharge>;
  refund(
    ref: TenantRef,
    request: { idempotencyKey: string; entryId: CreditEntryId },
  ): Promise<void>;
}

export interface LedgerBudgetOptions {
  readonly ledger: CreditLedger;
  // Costs belong to whoever runs the pool and change with calibration, so they come from the
  // host and are read on every charge.
  readonly creditsFor: (operation: AiOperation) => Credits;
}

interface ChargeRequest {
  readonly organization: OrganizationRef;
  readonly key: string;
  readonly operation: AiOperation;
  readonly floor: Credits | undefined;
}

function own(target: object, name: string): unknown {
  return Object.hasOwn(target, name) ? (target as Record<string, unknown>)[name] : undefined;
}

// Same order as the ledger: organization, key, then the body. Nothing is read or charged
// before the whole request is known to be well formed.
function chargeRequestOf(ref: unknown, request: unknown): ChargeRequest {
  const organization = { organizationId: organizationOf(ref) };
  const { request: body, key } = keyOf(request);
  const value = own(body, 'operation');
  const operation = AI_OPERATIONS.find((known) => known === value);
  if (operation === undefined) throw new CreditError('CREDIT_REASON_INVALID');
  const floor = Object.hasOwn(body, 'floor') ? credits(own(body, 'floor')) : undefined;
  return { organization, key, operation, floor };
}

interface RefundRequest {
  readonly organization: OrganizationRef;
  readonly key: string;
  readonly body: object;
}

function refundRequestOf(ref: unknown, request: unknown): RefundRequest {
  const organization = { organizationId: organizationOf(ref) };
  const { request: body, key } = keyOf(request);
  return { organization, key, body };
}

const CHARGE_UNMETERED: AiCharge = Object.freeze({ status: 'unmetered' });
const CHARGE_REFUSED: AiCharge = Object.freeze({ status: 'refused' });

// Self hosted installs run their own models on their own bill, so nothing is counted.
// Requests are still checked, so a caller bug fails the same way on every install.
export function unmeteredBudget(): AiBudget {
  return Object.freeze({
    charge(ref: TenantRef, request: unknown): Promise<AiCharge> {
      return Promise.resolve().then(() => {
        chargeRequestOf(ref, request);
        return CHARGE_UNMETERED;
      });
    },
    refund(ref: TenantRef, request: unknown): Promise<void> {
      return Promise.resolve().then(() => {
        refundRequestOf(ref, request);
      });
    },
  });
}

export function createLedgerBudget(options: LedgerBudgetOptions): AiBudget {
  const { ledger, creditsFor } = options;
  return Object.freeze({
    async charge(ref: TenantRef, request: unknown): Promise<AiCharge> {
      const { organization, key, operation, floor } = chargeRequestOf(ref, request);
      const amount = entryAmount(creditsFor(operation));
      // The floor is checked by a read before the spend, so parallel charges can each pass it
      // and together go below it by at most their count times the cost. Callers bound that
      // with their concurrency limit. A retry of a charge that already applied may be refused
      // here once the pool has fallen; recovery repeats the charge without a floor instead.
      if (floor !== undefined && floor > 0) {
        const balance = await ledger.balance(organization);
        if (balance < floor || balance - floor < amount) return CHARGE_REFUSED;
      }
      const outcome = await ledger.spend(organization, {
        idempotencyKey: key,
        amount,
        reason: operation,
      });
      if (outcome.status !== 'applied') return CHARGE_REFUSED;
      return Object.freeze({ status: 'charged', entryId: outcome.entry.id });
    },
    async refund(ref: TenantRef, request: unknown): Promise<void> {
      const { organization, key, body } = refundRequestOf(ref, request);
      // A malformed id can name no entry, so it fails like an unknown one, as in the ledger.
      const entryId = entryIdOf(body);
      if (entryId === undefined) throw new CreditError('CREDIT_ENTRY_NOT_FOUND');
      await ledger.reverse(organization, { idempotencyKey: key, entryId });
    },
  });
}
