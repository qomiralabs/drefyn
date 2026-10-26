import { randomUUID } from 'node:crypto';
import { idOf, type OrganizationId, type OrganizationRef } from '@drefyn/tenancy';
import { credits, type Credits } from './amounts.ts';
import { CreditError } from './errors.ts';
import {
  amountOf,
  entryIdOf,
  keyOf,
  organizationOf,
  reasonOf,
  type CreditEntry,
  type CreditEntryId,
  type CreditLedger,
  type CreditOutcome,
  type EntryKind,
  type SpendReason,
} from './ledger.ts';

type Applied = Extract<CreditOutcome, { status: 'applied' }>;

// What makes two requests under one key the same request. A reversal is identified by the
// entry it resolved to, so a retry naming the same spend replays instead of conflicting.
interface Identity {
  readonly kind: EntryKind;
  readonly amount: number | undefined;
  readonly reason: SpendReason | undefined;
  readonly target: CreditEntryId | undefined;
}

interface Pool {
  balance: number;
  readonly entries: CreditEntry[];
  view: readonly CreditEntry[] | undefined;
  readonly byKey: Map<string, { readonly identity: Identity; readonly outcome: Applied }>;
  readonly byId: Map<CreditEntryId, CreditEntry>;
  readonly reversed: Set<CreditEntryId>;
}

const EMPTY: readonly CreditEntry[] = Object.freeze([]);

function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.kind === b.kind && a.amount === b.amount && a.reason === b.reason && a.target === b.target
  );
}

// Comparing against the headroom keeps the check exact; the sum itself could round past 2^53.
function fitsUnderLimit(balance: number, amount: number): boolean {
  return amount <= Number.MAX_SAFE_INTEGER - balance;
}

// A throw inside the executor becomes a rejection, so callers always get a promise and a
// bad argument never escapes as a synchronous throw.
function settle<T>(run: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(run());
  });
}

// For tests and local tools only: state lives in this process and is gone on restart.
// Every method validates, checks and appends without awaiting anything in between, so on
// one event loop each call is atomic per organization.
export function createMemoryLedger(): CreditLedger {
  const pools = new Map<OrganizationId, Pool>();

  function poolOf(organizationId: OrganizationId): Pool {
    let pool = pools.get(organizationId);
    if (pool === undefined) {
      pool = {
        balance: 0,
        entries: [],
        view: undefined,
        byKey: new Map(),
        byId: new Map(),
        reversed: new Set(),
      };
      pools.set(organizationId, pool);
    }
    return pool;
  }

  // Same key and same request replays the original outcome; a different request conflicts.
  // Runs before any balance or overflow check, so a conflict never depends on the balance.
  function replay(pool: Pool | undefined, key: string, identity: Identity): Applied | undefined {
    const seen = pool?.byKey.get(key);
    if (seen === undefined) return undefined;
    if (!sameIdentity(seen.identity, identity)) {
      throw new CreditError('CREDIT_IDEMPOTENCY_CONFLICT');
    }
    return seen.outcome;
  }

  function append(
    organizationId: OrganizationId,
    key: string,
    identity: Identity,
    amount: Credits,
    signed: number,
    fields: Record<string, unknown>,
  ): Applied {
    const pool = poolOf(organizationId);
    const entry = Object.freeze({
      id: idOf('crd', randomUUID()),
      organizationId,
      ...fields,
      amount,
      idempotencyKey: key,
    }) as CreditEntry;
    const outcome: Applied = Object.freeze({ status: 'applied', entry });
    pool.entries.push(entry);
    pool.view = undefined;
    pool.balance += signed;
    pool.byId.set(entry.id, entry);
    pool.byKey.set(key, { identity, outcome });
    return outcome;
  }

  function insufficient(requested: Credits, available: number): CreditOutcome {
    return Object.freeze({
      status: 'insufficient',
      requested,
      available: credits(available),
    });
  }

  // Spend and expiry share one rule: all or nothing against the current balance.
  function debit(ref: unknown, raw: unknown, kind: 'spend' | 'expiry'): CreditOutcome {
    const organizationId = organizationOf(ref);
    const { request, key } = keyOf(raw);
    const amount = amountOf(request);
    const reason = kind === 'spend' ? reasonOf(request) : undefined;
    const identity: Identity = { kind, amount, reason, target: undefined };
    const pool = pools.get(organizationId);
    const original = replay(pool, key, identity);
    if (original !== undefined) return original;
    const balance = pool?.balance ?? 0;
    if (amount > balance) return insufficient(amount, balance);
    return append(organizationId, key, identity, amount, 0 - amount, {
      kind,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  return {
    balance(ref: OrganizationRef): Promise<Credits> {
      return settle(() => credits(pools.get(organizationOf(ref))?.balance ?? 0));
    },

    entries(ref: OrganizationRef): Promise<readonly CreditEntry[]> {
      return settle(() => {
        const pool = pools.get(organizationOf(ref));
        if (pool === undefined) return EMPTY;
        pool.view ??= Object.freeze([...pool.entries]);
        return pool.view;
      });
    },

    grant(ref, raw) {
      return settle(() => {
        const organizationId = organizationOf(ref);
        const { request, key } = keyOf(raw);
        const amount = amountOf(request);
        const identity: Identity = { kind: 'grant', amount, reason: undefined, target: undefined };
        const pool = pools.get(organizationId);
        const original = replay(pool, key, identity);
        if (original !== undefined) return original;
        if (!fitsUnderLimit(pool?.balance ?? 0, amount)) {
          throw new CreditError('CREDIT_BALANCE_OVERFLOW');
        }
        return append(organizationId, key, identity, amount, amount, { kind: 'grant' });
      });
    },

    spend(ref, raw) {
      return settle(() => debit(ref, raw, 'spend'));
    },

    expire(ref, raw) {
      return settle(() => debit(ref, raw, 'expiry'));
    },

    reverse(ref, raw) {
      return settle(() => {
        const organizationId = organizationOf(ref);
        const { request, key } = keyOf(raw);
        const pool = pools.get(organizationId);
        // Another organization's entry is not in this pool, so it reads as not found and
        // nothing about it leaks.
        const requested = entryIdOf(request);
        const target = requested === undefined ? undefined : pool?.byId.get(requested);
        const identity: Identity = {
          kind: 'reversal',
          amount: undefined,
          reason: undefined,
          target: target?.id,
        };
        const original = replay(pool, key, identity);
        if (original !== undefined) return original;
        if (pool === undefined || target === undefined) {
          throw new CreditError('CREDIT_ENTRY_NOT_FOUND');
        }
        if (target.kind !== 'spend' || pool.reversed.has(target.id)) {
          throw new CreditError('CREDIT_NOT_REVERSIBLE');
        }
        if (!fitsUnderLimit(pool.balance, target.amount)) {
          throw new CreditError('CREDIT_BALANCE_OVERFLOW');
        }
        pool.reversed.add(target.id);
        return append(organizationId, key, identity, target.amount, target.amount, {
          kind: 'reversal',
          reverses: target.id,
        });
      });
    },
  };
}
