// A plain reference model of the ledger rules and the fast-check generators that drive it.
// Property tests run the same operations on the model and on the real ledger and compare.
import fc from 'fast-check';
import type { OrganizationRef } from '@drefyn/tenancy';
import {
  credits,
  type CreditEntry,
  type CreditEntryId,
  type CreditErrorCode,
  type CreditLedger,
  type SpendReason,
} from '../src/index.ts';
import { ORG_A, ORG_B, ORG_C, SAFE_MAX, asyncCodeOf } from './support.ts';

export const ORGS: readonly OrganizationRef[] = [ORG_A, ORG_B, ORG_C];
const REASONS: readonly SpendReason[] = ['generation', 'translation_draft', 'incident_draft'];
const UNKNOWN_ENTRY = '00000000-0000-0000-0000-000000000000' as CreditEntryId;

export type Op =
  | { readonly org: number; readonly kind: 'grant'; readonly key: string; readonly amount: number }
  | {
      readonly org: number;
      readonly kind: 'spend';
      readonly key: string;
      readonly amount: number;
      readonly reason: SpendReason;
    }
  | { readonly org: number; readonly kind: 'expiry'; readonly key: string; readonly amount: number }
  // target picks the n-th applied spend of that organization; -1 names an entry that does not exist.
  | {
      readonly org: number;
      readonly kind: 'reversal';
      readonly key: string;
      readonly target: number;
    };

export type Result =
  'applied' | 'insufficient' | CreditErrorCode | 'no error' | 'not a CreditError';

const amountArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 8, arbitrary: fc.integer({ min: 1, max: 60 }) },
  { weight: 1, arbitrary: fc.constantFrom(SAFE_MAX, SAFE_MAX - 1, 2 ** 52, 2 ** 31) },
);

// A small key pool forces reuse, so conflicts and replays both happen often.
export const keyArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('k0', 'k1', 'k2', 'k3', 'k4', 'k5') },
  { weight: 2, arbitrary: fc.string({ minLength: 1, maxLength: 12, unit: 'grapheme-ascii' }) },
);

export function opArb(orgs = ORGS.length, keys = keyArb): fc.Arbitrary<Op> {
  const org = fc.integer({ min: 0, max: orgs - 1 });
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc.record({
        org,
        kind: fc.constant('grant' as const),
        key: keys,
        amount: amountArb,
      }),
    },
    {
      weight: 4,
      arbitrary: fc.record({
        org,
        kind: fc.constant('spend' as const),
        key: keys,
        amount: amountArb,
        reason: fc.constantFrom(...REASONS),
      }),
    },
    {
      weight: 1,
      arbitrary: fc.record({
        org,
        kind: fc.constant('expiry' as const),
        key: keys,
        amount: amountArb,
      }),
    },
    {
      weight: 2,
      arbitrary: fc.record({
        org,
        kind: fc.constant('reversal' as const),
        key: keys,
        target: fc.integer({ min: -1, max: 6 }),
      }),
    },
  );
}

// Sequences that also repeat earlier operations verbatim, which is what a client retry is.
export function opsArb(orgs = ORGS.length, keys = keyArb): fc.Arbitrary<Op[]> {
  return fc
    .tuple(
      fc.array(opArb(orgs, keys), { minLength: 1, maxLength: 40 }),
      fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 15 }),
    )
    .map(([ops, repeats]) => {
      const out = [...ops];
      for (const [from, to] of repeats) {
        const op = out[from % out.length];
        if (op !== undefined) out.splice(to % (out.length + 1), 0, op);
      }
      return out;
    });
}

interface ModelEntry {
  readonly kind: CreditEntry['kind'];
  readonly amount: number;
  readonly idempotencyKey: string;
  readonly reason?: SpendReason;
  readonly reverses?: number;
}

interface OrgState {
  readonly entries: ModelEntry[];
  readonly keys: Map<string, { readonly request: string; readonly result: Result }>;
  readonly spends: number[];
  readonly reversed: Set<number>;
}

export class Model {
  private readonly orgs = new Map<number, OrgState>();

  private state(org: number): OrgState {
    let state = this.orgs.get(org);
    if (state === undefined) {
      state = { entries: [], keys: new Map(), spends: [], reversed: new Set() };
      this.orgs.set(org, state);
    }
    return state;
  }

  balance(org: number): number {
    return this.state(org).entries.reduce(
      (sum, e) => sum + (e.kind === 'grant' || e.kind === 'reversal' ? e.amount : -e.amount),
      0,
    );
  }

  apply(op: Op): Result {
    const state = this.state(op.org);
    const target =
      op.kind === 'reversal'
        ? op.target < 0 || state.spends.length === 0
          ? -1
          : (state.spends[op.target % state.spends.length] ?? -1)
        : undefined;
    const request = JSON.stringify(
      op.kind === 'reversal'
        ? { kind: op.kind, target }
        : { ...op, org: undefined, key: undefined },
    );
    const seen = state.keys.get(op.key);
    if (seen !== undefined)
      return seen.request === request ? seen.result : 'CREDIT_IDEMPOTENCY_CONFLICT';

    const balance = this.balance(op.org);
    let entry: ModelEntry;
    switch (op.kind) {
      case 'grant':
        if (balance + op.amount > SAFE_MAX) return 'CREDIT_BALANCE_OVERFLOW';
        entry = { kind: 'grant', amount: op.amount, idempotencyKey: op.key };
        break;
      case 'spend':
        if (op.amount > balance) return 'insufficient';
        entry = { kind: 'spend', amount: op.amount, idempotencyKey: op.key, reason: op.reason };
        break;
      case 'expiry':
        if (op.amount > balance) return 'insufficient';
        entry = { kind: 'expiry', amount: op.amount, idempotencyKey: op.key };
        break;
      case 'reversal': {
        const spent = target === undefined || target < 0 ? undefined : state.entries[target];
        if (spent === undefined || target === undefined) return 'CREDIT_ENTRY_NOT_FOUND';
        if (state.reversed.has(target)) return 'CREDIT_NOT_REVERSIBLE';
        if (balance + spent.amount > SAFE_MAX) return 'CREDIT_BALANCE_OVERFLOW';
        state.reversed.add(target);
        entry = {
          kind: 'reversal',
          amount: spent.amount,
          idempotencyKey: op.key,
          reverses: target,
        };
        break;
      }
    }
    if (entry.kind === 'spend') state.spends.push(state.entries.length);
    state.entries.push(entry);
    state.keys.set(op.key, { request, result: 'applied' });
    return 'applied';
  }

  // The same shape as snapshot() in support.ts.
  snapshot(org: number): { balance: number; entries: Record<string, unknown>[] } {
    const organizationId = ORGS[org]?.organizationId;
    return {
      balance: this.balance(org),
      entries: this.state(org).entries.map((entry, index) => ({
        id: index,
        organizationId,
        ...entry,
      })),
    };
  }
}

// Runs one operation on a real ledger. spends holds each organization's applied spend IDs
// in order, so a reversal target resolves the same way it does in the model.
export async function runOp(
  ledger: CreditLedger,
  op: Op,
  spends: Map<number, CreditEntryId[]>,
): Promise<Result> {
  const ref = ORGS[op.org];
  if (ref === undefined) throw new Error(`no organization ${op.org}`);
  const own = spends.get(op.org) ?? [];
  spends.set(op.org, own);
  let status: Result = 'applied';
  const code = await asyncCodeOf(async () => {
    switch (op.kind) {
      case 'grant':
        await ledger.grant(ref, { idempotencyKey: op.key, amount: credits(op.amount) });
        return;
      case 'spend': {
        const outcome = await ledger.spend(ref, {
          idempotencyKey: op.key,
          amount: credits(op.amount),
          reason: op.reason,
        });
        status = outcome.status;
        if (outcome.status === 'applied' && !own.includes(outcome.entry.id))
          own.push(outcome.entry.id);
        return;
      }
      case 'expiry':
        status = (await ledger.expire(ref, { idempotencyKey: op.key, amount: credits(op.amount) }))
          .status;
        return;
      case 'reversal': {
        const entryId =
          op.target < 0 || own.length === 0
            ? UNKNOWN_ENTRY
            : (own[op.target % own.length] ?? UNKNOWN_ENTRY);
        await ledger.reverse(ref, { idempotencyKey: op.key, entryId });
        return;
      }
    }
  });
  return code === 'no error' ? status : code;
}
