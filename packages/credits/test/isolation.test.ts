import { organizationId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { credits, type CreditLedger } from '../src/index.ts';
import { ORG_A, ORG_B, ORG_C, expectRejects, newLedger, snapshot, tenantOf } from './support.ts';

async function twoOrgs(): Promise<CreditLedger> {
  const ledger = newLedger();
  await ledger.grant(ORG_A, { idempotencyKey: 'seed', amount: credits(10) });
  await ledger.grant(ORG_B, { idempotencyKey: 'seed', amount: credits(3) });
  return ledger;
}

describe('one pool per organization', () => {
  it('keeps balances and entries apart', async () => {
    const ledger = await twoOrgs();
    await ledger.spend(ORG_A, { idempotencyKey: 's1', amount: credits(4), reason: 'generation' });
    expect(await ledger.balance(ORG_A)).toBe(6);
    expect(await ledger.balance(ORG_B)).toBe(3);
    expect(await ledger.balance(ORG_C)).toBe(0);
    for (const entry of await ledger.entries(ORG_B)) {
      expect(entry.organizationId).toBe(ORG_B.organizationId);
    }
    expect(await ledger.entries(ORG_C)).toEqual([]);
  });

  it('never lets one organization spend another one balance', async () => {
    const ledger = await twoOrgs();
    const outcome = await ledger.spend(ORG_B, {
      idempotencyKey: 's1',
      amount: credits(5),
      reason: 'generation',
    });
    expect(outcome).toEqual({ status: 'insufficient', requested: 5, available: 3 });
    expect(await ledger.balance(ORG_A)).toBe(10);
  });

  it('scopes idempotency keys to the organization', async () => {
    const ledger = await twoOrgs();
    const a = await ledger.spend(ORG_A, {
      idempotencyKey: 'job-1',
      amount: credits(2),
      reason: 'generation',
    });
    const b = await ledger.spend(ORG_B, {
      idempotencyKey: 'job-1',
      amount: credits(1),
      reason: 'incident_draft',
    });
    expect(a.status).toBe('applied');
    expect(b.status).toBe('applied');
    if (a.status !== 'applied' || b.status !== 'applied') return;
    expect(a.entry.id).not.toBe(b.entry.id);
    expect(await ledger.balance(ORG_A)).toBe(8);
    expect(await ledger.balance(ORG_B)).toBe(2);
  });

  it('cannot reverse another organization spend, and says not found rather than leaking it', async () => {
    const ledger = await twoOrgs();
    const spend = await ledger.spend(ORG_A, {
      idempotencyKey: 's1',
      amount: credits(4),
      reason: 'generation',
    });
    if (spend.status !== 'applied') throw new Error('setup failed');
    const beforeA = await snapshot(ledger, ORG_A);
    const beforeB = await snapshot(ledger, ORG_B);
    await expectRejects(
      () => ledger.reverse(ORG_B, { idempotencyKey: 'r1', entryId: spend.entry.id }),
      'CREDIT_ENTRY_NOT_FOUND',
    );
    expect(await snapshot(ledger, ORG_A)).toEqual(beforeA);
    expect(await snapshot(ledger, ORG_B)).toEqual(beforeB);
    const own = await ledger.reverse(ORG_A, { idempotencyKey: 'r1', entryId: spend.entry.id });
    expect(own.entry.amount).toBe(4);
  });

  it('shares one pool across the projects of an organization', async () => {
    const ledger = newLedger();
    const p1 = tenantOf(ORG_A, '01928c3e-7a9b-7c3d-8e4f-0000000000a1');
    const p2 = tenantOf(ORG_A, '01928c3e-7a9b-7c3d-8e4f-0000000000a2');
    await ledger.grant(p1, { idempotencyKey: 'g1', amount: credits(5) });
    await ledger.spend(p2, { idempotencyKey: 's1', amount: credits(2), reason: 'generation' });
    expect(await ledger.balance(ORG_A)).toBe(3);
    expect(await ledger.balance(p1)).toBe(3);
    const entries = await ledger.entries(p2);
    expect(entries).toHaveLength(2);
    for (const entry of entries) expect(Object.keys(entry)).not.toContain('projectId');
  });

  it('reads only the organization ID from the ref, so extra fields cannot redirect it', async () => {
    const ledger = await twoOrgs();
    const sneaky = { ...ORG_A, organization_id: ORG_B.organizationId, org: ORG_B };
    await ledger.spend(sneaky, { idempotencyKey: 's1', amount: credits(1), reason: 'generation' });
    expect(await ledger.balance(ORG_A)).toBe(9);
    expect(await ledger.balance(ORG_B)).toBe(3);
  });
});

describe('organization refs checked at run time', () => {
  const bad: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a bare ID string', ORG_A.organizationId],
    ['an empty object', {}],
    ['a malformed ID', { organizationId: 'not-a-uuid' }],
    ['an uppercase UUID', { organizationId: '01928C3E-7A9B-7C3D-8E4F-0123456789AB' }],
    ['a public ID', { organizationId: 'org_01arz3ndektsv4rrffq69g5fav' }],
    ['a number', { organizationId: 1 }],
    ['an inherited ID', Object.create({ organizationId: ORG_A.organizationId }) as unknown],
  ];

  type Call = (ledger: CreditLedger, ref: never) => Promise<unknown>;
  const calls: readonly [string, Call][] = [
    ['balance', (l, ref) => l.balance(ref)],
    ['entries', (l, ref) => l.entries(ref)],
    ['grant', (l, ref) => l.grant(ref, { idempotencyKey: 'k', amount: credits(1) })],
    [
      'spend',
      (l, ref) => l.spend(ref, { idempotencyKey: 'k', amount: credits(1), reason: 'generation' }),
    ],
    ['expire', (l, ref) => l.expire(ref, { idempotencyKey: 'k', amount: credits(1) })],
    [
      'reverse',
      (l, ref) => l.reverse(ref, { idempotencyKey: 'k', entryId: ORG_A.organizationId as never }),
    ],
  ];

  for (const [name, call] of calls) {
    it.each(bad)(`${name} rejects %s with CREDIT_ORGANIZATION_INVALID`, async (_label, ref) => {
      const ledger = await twoOrgs();
      const before = [await snapshot(ledger, ORG_A), await snapshot(ledger, ORG_B)];
      await expectRejects(() => call(ledger, ref as never), 'CREDIT_ORGANIZATION_INVALID');
      expect([await snapshot(ledger, ORG_A), await snapshot(ledger, ORG_B)]).toEqual(before);
    });
  }

  it('checks the organization before the request', async () => {
    const ledger = newLedger();
    await expectRejects(
      () => ledger.grant(null as never, { idempotencyKey: '', amount: 1.5 as never }),
      'CREDIT_ORGANIZATION_INVALID',
    );
  });

  it('accepts any canonical organization ID, including the nil and max UUIDs', async () => {
    const ledger = newLedger();
    for (const value of [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]) {
      const ref = { organizationId: organizationId(value) };
      await ledger.grant(ref, { idempotencyKey: 'g', amount: credits(1) });
      expect(await ledger.balance(ref)).toBe(1);
    }
  });
});
