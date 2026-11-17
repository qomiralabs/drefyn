import { afterEach, describe, expect, it } from 'vitest';
import { createBillingClient } from '../src/index.ts';
import type { FakeBillingProvider } from '../src/fake.ts';
import { startFakeBillingProvider } from '../src/fake.ts';
import { ORG, OUTSIDER, OWNER, TOKEN, fakeOptions, startFake } from './support.ts';

let fake: FakeBillingProvider | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const client = (provider: FakeBillingProvider) =>
  createBillingClient({
    baseUrl: provider.url,
    token: TOKEN,
    timeoutMs: 2000,
    actor: { userId: OWNER },
  });

describe('fake billing provider', () => {
  it('listens on loopback only', async () => {
    fake = await startFake();
    expect(new URL(fake.url).hostname).toBe('127.0.0.1');
  });

  it('keeps a bounded request log', async () => {
    fake = await startFake();
    const c = client(fake);
    for (let i = 0; i < 205; i += 1) await c.plans();
    expect(fake.requests()).toHaveLength(200);
  });

  it('starts fresh on a scenario change', async () => {
    fake = await startFake();
    const c = client(fake);
    await c.changePlan(ORG, {
      tier: 'growth',
      interval: 'month',
      keepEditable: [],
      idempotencyKey: 'fresh-0001',
    });
    fake.setScenario('active');
    expect((await c.summary(ORG)).plan.tier).toBe('starter');
    expect(fake.requests()).toHaveLength(1);
  });

  it('closes twice without complaint, and closes while a slow answer waits', async () => {
    fake = await startFake({ scenario: 'slow', slowMs: 60_000 });
    const pending = client(fake)
      .summary(ORG)
      .catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fake.close();
    await fake.close();
    expect(await pending).toBeInstanceOf(Error);
  });

  it('refuses options it cannot work with', async () => {
    await expect(startFakeBillingProvider({ ...fakeOptions(), plans: [] })).rejects.toThrow(
      /plans/,
    );
    await expect(
      startFakeBillingProvider({
        ...fakeOptions(),
        plans: [{ tier: 'starter', interval: 'month', amountCents: 1.5, currency: 'usd' }],
      }),
    ).rejects.toThrow(/plans/);
  });

  it('a free organization with no card has no invoices to pay', async () => {
    fake = await startFake({ scenario: 'no_card', invoiceCount: 0 });
    expect(await client(fake).invoices(ORG, { limit: 10 })).toEqual({ items: [], next: null });
  });
});

describe('fake billing provider refusals the client never triggers', () => {
  const raw = async (
    provider: FakeBillingProvider,
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ) => {
    const response = await fetch(`${provider.url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'drefyn-actor': OWNER,
        ...init.headers,
      },
      body: init.body ?? null,
      signal: AbortSignal.timeout(5000),
    });
    const text = await response.text();
    return { status: response.status, text };
  };

  const write = {
    method: 'PUT',
    headers: { 'idempotency-key': 'raw-key-0001', 'content-type': 'application/json' },
  };

  it.each([
    ['a path outside the contract', '/nope'],
    ['an unknown route under an organization', `/billing/v1/orgs/${ORG}/nope`],
    ['an organization id that is not one', '/billing/v1/orgs/not-an-id/summary'],
  ])('refuses %s as invalid input', async (_, path) => {
    fake = await startFake();
    const { status, text } = await raw(fake, path);
    expect(status).toBe(422);
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'billing.invalid_input' } });
  });

  it('refuses a request with no actor', async () => {
    fake = await startFake();
    const { status } = await raw(fake, `/billing/v1/orgs/${ORG}/summary`, {
      headers: { 'drefyn-actor': '' },
    });
    expect(status).toBe(403);
  });

  it('refuses plans to someone with no role', async () => {
    fake = await startFake();
    const { status } = await raw(fake, '/billing/v1/plans', {
      headers: { 'drefyn-actor': OUTSIDER },
    });
    expect(status).toBe(403);
  });

  it('refuses a body that is not JSON', async () => {
    fake = await startFake();
    const { status, text } = await raw(fake, `/billing/v1/orgs/${ORG}/details`, {
      ...write,
      body: '{',
    });
    expect(status).toBe(422);
    expect(text).toMatch(/not JSON/);
  });

  it('answers unavailable rather than crash on a path it cannot decode', async () => {
    fake = await startFake();
    const { status } = await raw(fake, `/billing/v1/orgs/${ORG}/tax-ids/%E0%A4%A`, {
      method: 'DELETE',
      headers: { 'idempotency-key': 'raw-key-0002' },
    });
    expect(status).toBe(503);
  });

  it('forgets the oldest idempotency key past its bound', async () => {
    const provider = await startFake({ maxIdempotencyKeys: 2 });
    fake = provider;
    const path = `/billing/v1/orgs/${ORG}/payment-method/session`;
    const post = (key: string) =>
      raw(provider, path, { method: 'POST', headers: { 'idempotency-key': key } });
    await post('bound-key-1');
    await post('bound-key-2');
    await post('bound-key-3');
    // A different body under the forgotten key is new work, not a conflict.
    const again = await raw(fake, `/billing/v1/orgs/${ORG}/payment-method/session?x=1`, {
      method: 'POST',
      headers: { 'idempotency-key': 'bound-key-1' },
    });
    expect(again.status).toBe(200);
    const conflict = await raw(fake, `/billing/v1/orgs/${ORG}/payment-method/session?x=2`, {
      method: 'POST',
      headers: { 'idempotency-key': 'bound-key-3' },
    });
    expect(conflict.status).toBe(409);
  });
});
