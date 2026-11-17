import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BILLING_ERROR_CODES,
  BillingError,
  createBillingClient,
  isBillingError,
} from '../src/index.ts';
import type { BillingClient, BillingErrorCode } from '../src/index.ts';
import type { FakeBillingProvider, FakeScenario } from '../src/fake.ts';
import { ADMIN, ORG, OUTSIDER, OWNER, PROJECTS, TOKEN, startFake } from './support.ts';

let fake: FakeBillingProvider;

const clientFor = (
  actor = OWNER,
  extra: { token?: string; timeoutMs?: number; baseUrl?: string } = {},
) =>
  createBillingClient({
    baseUrl: extra.baseUrl ?? fake.url,
    token: extra.token ?? TOKEN,
    timeoutMs: extra.timeoutMs ?? 2000,
    actor: { userId: actor },
  });

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (isBillingError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a billing error');
}

const address = {
  line1: '1 Paper Street',
  line2: null,
  city: 'Lagos',
  state: null,
  postalCode: null,
  country: 'NG',
};

beforeEach(async () => {
  fake = await startFake();
});

afterEach(async () => {
  await fake.close();
});

describe('headers', () => {
  it('sends the bearer token and actor on every call and a key on every write', async () => {
    const client = clientFor();
    await client.summary(ORG);
    await client.plans();
    await client.preview(ORG, { tier: 'growth', interval: 'month' });
    await client.changePlan(ORG, {
      tier: 'growth',
      interval: 'month',
      keepEditable: [],
      idempotencyKey: 'change-plan-0001',
    });
    await client.updateDetails(ORG, { billingEmail: 'billing@example.com', address });
    await client.paymentMethodSession(ORG);
    const requests = fake.requests();
    expect(requests).toHaveLength(6);
    for (const request of requests) {
      expect(request.bearer).toBe(true);
      expect(request.actor).toBe(OWNER);
      if (request.method === 'GET') expect(request.idempotencyKey).toBeNull();
      else expect(request.idempotencyKey).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
    }
    expect(requests.find((r) => r.path.endsWith('/plan-changes'))?.idempotencyKey).toBe(
      'change-plan-0001',
    );
  });

  it('gives each generated write its own key', async () => {
    const client = clientFor();
    await client.paymentMethodSession(ORG);
    await client.paymentMethodSession(ORG);
    const [a, b] = fake.requests();
    expect(a?.idempotencyKey).not.toBe(b?.idempotencyKey);
  });

  it('works with a trailing slash on the base URL', async () => {
    const summary = await clientFor(OWNER, { baseUrl: `${fake.url}/` }).summary(ORG);
    expect(summary.organizationId).toBe(ORG);
  });
});

describe('error codes', () => {
  const cases: readonly {
    code: BillingErrorCode;
    scenario?: FakeScenario;
    run: (client: BillingClient) => Promise<unknown>;
    actor?: typeof OWNER;
  }[] = [
    { code: 'billing.unavailable', scenario: 'unavailable', run: (c) => c.summary(ORG) },
    { code: 'billing.forbidden', actor: OUTSIDER, run: (c) => c.summary(ORG) },
    {
      code: 'billing.forbidden',
      actor: ADMIN,
      run: (c) => c.cancelPendingChange(ORG, { idempotencyKey: 'cancel-pending-1' }),
    },
    {
      code: 'billing.invalid_input',
      run: (c) => c.invoiceLink(ORG, { invoiceId: 'inv_missing', purpose: 'pdf' }),
    },
    {
      code: 'billing.same_plan',
      run: (c) => c.preview(ORG, { tier: 'starter', interval: 'month' }),
    },
    {
      code: 'billing.pending_change_exists',
      scenario: 'scheduled_downgrade',
      run: (c) =>
        c.changePlan(ORG, {
          tier: 'free',
          interval: 'month',
          keepEditable: [],
          idempotencyKey: 'second-downgrade',
        }),
    },
    {
      code: 'billing.contract_plan',
      scenario: 'contract',
      run: (c) => c.preview(ORG, { tier: 'scale', interval: 'year' }),
    },
    {
      code: 'billing.keep_over_limit',
      run: (c) =>
        c.changePlan(ORG, {
          tier: 'free',
          interval: 'month',
          keepEditable: [...PROJECTS],
          idempotencyKey: 'keep-too-many',
        }),
    },
    {
      code: 'billing.tax_id_invalid',
      run: (c) => c.addTaxId(ORG, { type: 'eu_vat', value: 'not valid!' }),
    },
  ];

  it('covers every code', () => {
    const seen = new Set(cases.map((c) => c.code));
    seen.add('billing.idempotency_conflict');
    expect([...seen].sort()).toEqual([...BILLING_ERROR_CODES].sort());
  });

  it.each(cases.map((c) => [c.code, c] as const))('maps %s to a typed error', async (code, c) => {
    if (c.scenario !== undefined) fake.setScenario(c.scenario);
    const error = await c.run(clientFor(c.actor)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BillingError);
    expect((error as BillingError).code).toBe(code);
    expect((error as BillingError).name).toBe('BillingError');
  });

  it('maps billing.idempotency_conflict when one key carries two bodies', async () => {
    const client = clientFor();
    const input = {
      tier: 'growth',
      interval: 'month',
      keepEditable: [],
      idempotencyKey: 'same-key-1',
    } as const;
    await client.changePlan(ORG, input);
    expect(await codeOf(client.changePlan(ORG, { ...input, tier: 'scale' }))).toBe(
      'billing.idempotency_conflict',
    );
  });

  it('replays the first answer for a repeated key and body', async () => {
    const client = clientFor();
    const input = {
      tier: 'growth',
      interval: 'month',
      keepEditable: [],
      idempotencyKey: 'repeat-key-1',
    } as const;
    const first = await client.changePlan(ORG, input);
    const second = await client.changePlan(ORG, input);
    expect(second).toEqual(first);
  });

  it('keeps the provider message for a person to read', async () => {
    const error = await clientFor()
      .addTaxId(ORG, { type: 'eu_vat', value: 'not valid!' })
      .catch((e: unknown) => e);
    expect((error as BillingError).message).toMatch(/tax id/i);
  });
});

describe('a provider that misbehaves surfaces as billing.unavailable', () => {
  it('when slower than the timeout', async () => {
    fake.setScenario('slow');
    const started = Date.now();
    expect(await codeOf(clientFor(OWNER, { timeoutMs: 100 }).summary(ORG))).toBe(
      'billing.unavailable',
    );
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('when a success body fails the schema', async () => {
    fake.setScenario('malformed');
    expect(await codeOf(clientFor().summary(ORG))).toBe('billing.unavailable');
  });

  it('when an error body is not an error body', async () => {
    fake.setScenario('malformed');
    expect(await codeOf(clientFor().paymentMethodSession(ORG))).toBe('billing.unavailable');
  });

  it('when the answer is larger than the cap', async () => {
    fake.setScenario('oversized');
    expect(await codeOf(clientFor().summary(ORG))).toBe('billing.unavailable');
  });

  it('when nothing listens', async () => {
    const url = fake.url;
    await fake.close();
    expect(await codeOf(clientFor(OWNER, { baseUrl: url }).plans())).toBe('billing.unavailable');
    fake = await startFake();
  });

  it('when the token is wrong, as forbidden and not a crash', async () => {
    expect(await codeOf(clientFor(OWNER, { token: 'x'.repeat(40) }).summary(ORG))).toBe(
      'billing.forbidden',
    );
  });
});

describe('input checks before the network', () => {
  it('refuses a bad idempotency key without sending anything', async () => {
    expect(
      await codeOf(
        clientFor().changePlan(ORG, {
          tier: 'growth',
          interval: 'month',
          keepEditable: [],
          idempotencyKey: 'no',
        }),
      ),
    ).toBe('billing.invalid_input');
    expect(fake.requests()).toHaveLength(0);
  });

  it('refuses a bad body and a bad organization id', async () => {
    const client = clientFor();
    expect(await codeOf(client.updateDetails(ORG, { billingEmail: 'nope', address }))).toBe(
      'billing.invalid_input',
    );
    expect(await codeOf(client.summary('org_1' as typeof ORG))).toBe('billing.invalid_input');
    expect(await codeOf(client.invoices(ORG, { limit: 11 as 10 }))).toBe('billing.invalid_input');
    expect(fake.requests()).toHaveLength(0);
  });

  it('a cursor the provider did not hand out is invalid input', async () => {
    expect(await codeOf(clientFor().invoices(ORG, { limit: 10, cursor: 'abc' }))).toBe(
      'billing.invalid_input',
    );
  });

  it.each([
    ['a base URL that is not http', { baseUrl: 'ftp://billing.internal' }],
    ['a short token', { token: 'short' }],
    ['a zero timeout', { timeoutMs: 0 }],
  ])('refuses %s', (_, extra) => {
    expect(() => clientFor(OWNER, extra)).toThrow(BillingError);
  });

  it('refuses an actor that is not a user id', () => {
    expect(() =>
      createBillingClient({
        baseUrl: fake.url,
        token: TOKEN,
        timeoutMs: 1000,
        actor: { userId: 'someone' as typeof OWNER },
      }),
    ).toThrow(/actor/);
  });
});

describe('flows against the fake', () => {
  it('first upgrade from free redirects to a hosted checkout', async () => {
    fake.setScenario('no_card');
    const client = clientFor();
    const summary = await client.summary(ORG);
    expect(summary.paymentMethod).toBeNull();
    expect(summary.plan.status).toBe('none');
    const result = await client.changePlan(ORG, {
      tier: 'starter',
      interval: 'month',
      keepEditable: [],
      idempotencyKey: 'first-upgrade',
    });
    expect(result.kind).toBe('redirect');
  });

  it('an upgrade with a card on file waits for payment and then shows the new plan', async () => {
    const client = clientFor();
    const preview = await client.preview(ORG, { tier: 'growth', interval: 'month' });
    expect(preview).toMatchObject({ kind: 'upgrade', effective: 'now', dueNowCents: 1000 });
    expect(
      await client.changePlan(ORG, {
        tier: 'growth',
        interval: 'month',
        keepEditable: [],
        idempotencyKey: 'upgrade-0001',
      }),
    ).toEqual({ kind: 'pending_payment' });
    expect((await client.summary(ORG)).plan.tier).toBe('growth');
  });

  it('a declined card leaves the plan unchanged', async () => {
    fake.setScenario('declined_upgrade');
    const client = clientFor();
    const result = await client.changePlan(ORG, {
      tier: 'scale',
      interval: 'month',
      keepEditable: [],
      idempotencyKey: 'declined-0001',
    });
    expect(result).toEqual({ kind: 'declined', reason: 'card_declined' });
    expect((await client.summary(ORG)).plan.tier).toBe('starter');
  });

  it('a downgrade is scheduled for the period end and can be cancelled', async () => {
    const client = clientFor();
    const preview = await client.preview(ORG, { tier: 'free', interval: 'month' });
    expect(preview).toMatchObject({ kind: 'downgrade', effective: 'period_end', dueNowCents: 0 });
    const result = await client.changePlan(ORG, {
      tier: 'free',
      interval: 'month',
      keepEditable: [PROJECTS[0]],
      idempotencyKey: 'downgrade-0001',
    });
    expect(result.kind).toBe('scheduled');
    expect((await client.summary(ORG)).pendingChange?.tier).toBe('free');
    await client.setKeepEditable(ORG, { keepEditable: [PROJECTS[1]], idempotencyKey: 'keep-0001' });
    await client.cancelPendingChange(ORG, { idempotencyKey: 'cancel-0001' });
    expect((await client.summary(ORG)).pendingChange).toBeNull();
  });

  it('annual to monthly waits for renewal; monthly to annual starts now', async () => {
    const client = clientFor();
    expect(await client.preview(ORG, { tier: 'starter', interval: 'year' })).toMatchObject({
      kind: 'interval_change',
      effective: 'now',
    });
    await client.changePlan(ORG, {
      tier: 'starter',
      interval: 'year',
      keepEditable: [],
      idempotencyKey: 'to-annual-1',
    });
    expect(await client.preview(ORG, { tier: 'starter', interval: 'month' })).toMatchObject({
      kind: 'interval_change',
      effective: 'period_end',
    });
  });

  it('an upgrade while a downgrade is pending replaces it', async () => {
    fake.setScenario('scheduled_downgrade');
    const client = clientFor();
    await client.changePlan(ORG, {
      tier: 'scale',
      interval: 'month',
      keepEditable: [],
      idempotencyKey: 'upgrade-over-pending',
    });
    const summary = await client.summary(ORG);
    expect(summary.pendingChange).toBeNull();
    expect(summary.plan.tier).toBe('scale');
  });

  it('shows past due with the stated date and an expiring card', async () => {
    fake.setScenario('past_due');
    expect((await clientFor().summary(ORG)).plan.pastDueRestrictsOn).not.toBeNull();
    fake.setScenario('card_expiring');
    const card = (await clientFor(ADMIN).summary(ORG)).paymentMethod;
    expect(card).toMatchObject({ expMonth: 1, expYear: 2030 });
  });

  it('pages invoices and fetches a fresh link', async () => {
    const client = clientFor();
    const first = await client.invoices(ORG, { limit: 10 });
    expect(first.items).toHaveLength(10);
    expect(first.next).not.toBeNull();
    const second = await client.invoices(ORG, { limit: 25, cursor: first.next ?? '' });
    expect(second.items[0]?.invoiceId).not.toBe(first.items[0]?.invoiceId);
    const invoiceId = first.items[0]?.invoiceId ?? '';
    expect((await client.invoiceLink(ORG, { invoiceId, purpose: 'pay' })).url).toMatch(/^https:/);
  });

  it('updates details and adds and removes a tax id', async () => {
    const client = clientFor();
    const updated = await client.updateDetails(ORG, {
      billingEmail: 'billing@example.com',
      address,
    });
    expect(updated.billingEmail).toBe('billing@example.com');
    const added = await client.addTaxId(ORG, { type: 'eu_vat', value: 'DE123456789' });
    const [taxId] = added.taxIds;
    expect(taxId?.verification).toBe('pending');
    const removed = await client.removeTaxId(ORG, { id: taxId?.id ?? '' });
    expect(removed.taxIds).toEqual([]);
  });

  it('lists the plans the provider offers', async () => {
    expect(await clientFor().plans()).toHaveLength(6);
  });
});
