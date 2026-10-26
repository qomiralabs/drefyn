// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { IdOf, OrganizationId, OrganizationRef, ProjectId, TenantRef } from '@drefyn/tenancy';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  credits,
  createMemoryLedger,
  type CreditEntry,
  type CreditEntryId,
  type CreditErrorCode,
  type CreditLedger,
  type CreditOutcome,
  type Credits,
  type EntryKind,
  type SpendReason,
} from '../../src/index.ts';

declare const org: OrganizationId;
declare const prj: ProjectId;
declare const usr: IdOf<'usr'>;
declare const orgRef: OrganizationRef;
declare const tenant: TenantRef;
declare const amount: Credits;
declare const entryId: CreditEntryId;
declare const plainNumber: number;
declare const plainString: string;
declare const ledger: CreditLedger;

function takesCredits(value: Credits): Credits {
  return value;
}
function takesEntryId(value: CreditEntryId): CreditEntryId {
  return value;
}
function use(...values: unknown[]): number {
  return values.length;
}
function takesOrganizationId(value: OrganizationId): OrganizationId {
  return value;
}

async function compileOnly(): Promise<void> {
  // Amounts come only from credits(), so a raw number never reaches the ledger unchecked.
  // @ts-expect-error a plain number is not Credits
  takesCredits(plainNumber);
  // @ts-expect-error a literal is not Credits
  takesCredits(5);
  // @ts-expect-error arithmetic on Credits gives a number, which must go back through credits()
  takesCredits(amount + amount);
  takesCredits(credits(plainNumber + amount));
  const asNumber: number = amount;
  use(asNumber);

  // Every call needs an organization ref built from a branded OrganizationId.
  // @ts-expect-error a bare OrganizationId is not a ref
  await ledger.balance(org);
  // @ts-expect-error a plain string is not an OrganizationId
  await ledger.balance({ organizationId: plainString });
  // @ts-expect-error a ProjectId is not an OrganizationId
  await ledger.balance({ organizationId: prj });
  // @ts-expect-error a user ID is not an OrganizationId
  await ledger.grant({ organizationId: usr }, { idempotencyKey: 'k', amount });
  // @ts-expect-error a ref is required
  await ledger.entries();
  await ledger.balance(orgRef);
  await ledger.balance(tenant);

  // Requests.
  await ledger.grant(orgRef, { idempotencyKey: 'k', amount });
  // @ts-expect-error a grant without a key
  await ledger.grant(orgRef, { amount });
  // @ts-expect-error a grant with a raw number
  await ledger.grant(orgRef, { idempotencyKey: 'k', amount: 5 });
  // @ts-expect-error a spend without a reason
  await ledger.spend(orgRef, { idempotencyKey: 'k', amount });
  // @ts-expect-error SMS is a plan allowance, never a credit spend
  await ledger.spend(orgRef, { idempotencyKey: 'k', amount, reason: 'sms' });
  // @ts-expect-error voice is a plan allowance, never a credit spend
  await ledger.spend(orgRef, { idempotencyKey: 'k', amount, reason: 'voice' });
  // @ts-expect-error email sends are capped by entitlements, never a credit spend
  await ledger.spend(orgRef, { idempotencyKey: 'k', amount, reason: 'email' });
  // @ts-expect-error a reversal names the entry it reverses, not an amount
  await ledger.reverse(orgRef, { idempotencyKey: 'k', amount });
  // @ts-expect-error an OrganizationId is not a CreditEntryId
  await ledger.reverse(orgRef, { idempotencyKey: 'k', entryId: org });
  // @ts-expect-error a plain string is not a CreditEntryId
  await ledger.reverse(orgRef, { idempotencyKey: 'k', entryId: plainString });
  await ledger.reverse(orgRef, { idempotencyKey: 'k', entryId });

  // Outcomes: a grant or reversal is applied or throws; a spend or expiry may be refused.
  const granted = await ledger.grant(orgRef, { idempotencyKey: 'k', amount });
  takesEntryId(granted.entry.id);
  const spent = await ledger.spend(orgRef, { idempotencyKey: 'k', amount, reason: 'generation' });
  // Only the status is common to both outcomes, so the entry needs narrowing first.
  expectTypeOf<keyof CreditOutcome>().toEqualTypeOf<'status'>();
  if (spent.status === 'applied') takesEntryId(spent.entry.id);
  if (spent.status === 'insufficient') takesCredits(spent.available);

  // Entries: built only by the ledger, always carrying a branded organization ID.
  const entries = await ledger.entries(orgRef);
  const [first] = entries;
  if (first !== undefined) {
    takesOrganizationId(first.organizationId);
    // @ts-expect-error entries are read only
    first.amount = amount;
    // @ts-expect-error an entry keeps its ID
    first.id = entryId;
    if (first.kind === 'spend') {
      const reason: SpendReason = first.reason;
      use(reason);
    }
    if (first.kind === 'reversal') takesEntryId(first.reverses);
    // @ts-expect-error only a spend has a reason
    if (first.kind === 'grant') use(first.reason);
  }
  expectTypeOf(entries).toEqualTypeOf<readonly CreditEntry[]>();

  // @ts-expect-error an entry cannot be built without an organization ID
  const noOrg: CreditEntry = { id: entryId, kind: 'grant', amount, idempotencyKey: 'k' };
  use(noOrg);
  const withProject: CreditEntry = {
    id: entryId,
    // @ts-expect-error an entry takes an OrganizationId, not a ProjectId
    organizationId: prj,
    kind: 'grant',
    amount,
    idempotencyKey: 'k',
  };
  use(withProject);
  const rawAmount: CreditEntry = {
    id: entryId,
    organizationId: org,
    kind: 'grant',
    // @ts-expect-error an entry amount is Credits, not a number
    amount: 1,
    idempotencyKey: 'k',
  };
  use(rawAmount);
  // @ts-expect-error a CreditEntryId cannot be minted from a string
  const mintedId: CreditEntryId = plainString;
  use(mintedId);
  // @ts-expect-error a send is not an entry kind
  const sendKind: EntryKind = 'send';
  use(sendKind);
  // @ts-expect-error codes are a closed union
  const madeUpCode: CreditErrorCode = 'CREDIT_OOPS';
  use(madeUpCode);
}

describe('type level API', () => {
  it('pins the shapes the typecheck relies on', () => {
    expectTypeOf(credits).returns.toEqualTypeOf<Credits>();
    expectTypeOf(createMemoryLedger).returns.toEqualTypeOf<CreditLedger>();
    expectTypeOf<CreditEntryId>().toEqualTypeOf<IdOf<'crd'>>();
    expectTypeOf<EntryKind>().toEqualTypeOf<'grant' | 'spend' | 'reversal' | 'expiry'>();
    expectTypeOf<SpendReason>().toEqualTypeOf<
      'generation' | 'translation_draft' | 'incident_draft'
    >();
    expectTypeOf<CreditOutcome['status']>().toEqualTypeOf<'applied' | 'insufficient'>();
    expectTypeOf<CreditLedger['balance']>().parameters.toEqualTypeOf<[OrganizationRef]>();
    expectTypeOf<CreditLedger['balance']>().returns.toEqualTypeOf<Promise<Credits>>();
    expectTypeOf<CreditErrorCode>().toEqualTypeOf<
      | 'CREDIT_AMOUNT_INVALID'
      | 'CREDIT_KEY_INVALID'
      | 'CREDIT_REASON_INVALID'
      | 'CREDIT_ORGANIZATION_INVALID'
      | 'CREDIT_IDEMPOTENCY_CONFLICT'
      | 'CREDIT_ENTRY_NOT_FOUND'
      | 'CREDIT_NOT_REVERSIBLE'
      | 'CREDIT_BALANCE_OVERFLOW'
    >();
  });

  it('loads', () => {
    expect(typeof compileOnly).toBe('function');
  });
});
