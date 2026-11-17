import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  BILLING_CONTRACT_VERSION,
  BILLING_ROUTES,
  billingSummarySchema,
  errorBodySchema,
  idempotencyKeySchema,
  invoicesQuerySchema,
  planChangeResultSchema,
  updateDetailsRequestSchema,
} from '../src/index.ts';
import { NOW, ORG, PLANS, PROJECTS } from './support.ts';

const address = {
  line1: '1 Paper Street',
  line2: null,
  city: 'Lagos',
  state: null,
  postalCode: '100001',
  country: 'NG',
};

const summary = {
  organizationId: ORG,
  plan: {
    tier: 'growth',
    interval: 'year',
    status: 'past_due',
    currentPeriodEnd: NOW,
    pastDueRestrictsOn: NOW,
  },
  pendingChange: { tier: 'starter', interval: 'month', effectiveAt: NOW },
  paymentMethod: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2031 },
  billingEmail: 'billing@example.com',
  address,
  taxIds: [{ id: 'txi_1', type: 'eu_vat', value: 'DE123456789', verification: 'pending' }],
};

const invoice = {
  invoiceId: 'inv_1',
  number: 'A-0001',
  status: 'paid',
  amountDueCents: 2000,
  amountPaidCents: 2000,
  currency: 'usd',
  createdAt: NOW,
};

// One valid sample per request and response, keyed by route name.
const samples: Record<string, { request?: unknown; response?: unknown }> = {
  summary: { response: summary },
  plans: { response: { plans: PLANS } },
  preview: {
    request: { tier: 'scale', interval: 'month' },
    response: {
      kind: 'upgrade',
      effective: 'now',
      effectiveAt: NOW,
      dueNowCents: 1000,
      nextInvoiceCents: 3000,
      currency: 'usd',
    },
  },
  changePlan: {
    request: { tier: 'free', interval: 'month', keepEditable: [PROJECTS[0]] },
    response: { kind: 'scheduled', effectiveAt: NOW },
  },
  cancelPendingChange: {},
  setKeepEditable: { request: { keepEditable: [...PROJECTS] } },
  paymentMethodSession: { response: { url: 'https://checkout.example.com/s/1' } },
  updateDetails: {
    request: { billingEmail: 'billing@example.com', address },
    response: summary,
  },
  addTaxId: { request: { type: 'eu_vat', value: 'DE123456789' }, response: summary },
  removeTaxId: { response: summary },
  invoices: {
    request: { limit: 10, cursor: 'abc' },
    response: { items: [invoice], next: null },
  },
  invoiceLink: { request: { purpose: 'pdf' }, response: { url: 'https://pay.example.com/i/1' } },
};

const roundTrip = (schema: z.ZodType, value: unknown) =>
  schema.parse(JSON.parse(JSON.stringify(value)));

describe('contract', () => {
  it('is version 1 under /billing/v1', () => {
    expect(BILLING_CONTRACT_VERSION).toBe(1);
    for (const route of BILLING_ROUTES) expect(route.path.startsWith('/')).toBe(true);
  });

  it('has a sample for every route, so a new route cannot skip these tests', () => {
    expect(BILLING_ROUTES.map((route) => route.name).sort()).toEqual(Object.keys(samples).sort());
  });

  it.each(BILLING_ROUTES.map((route) => [route.name, route] as const))(
    '%s round trips its request and response',
    (name, route) => {
      const sample = samples[name] ?? {};
      if (route.request === null) expect(sample.request).toBeUndefined();
      else expect(roundTrip(route.request, sample.request)).toEqual(sample.request);
      if (route.response === null) expect(sample.response).toBeUndefined();
      else expect(roundTrip(route.response, sample.response)).toEqual(sample.response);
    },
  );

  it('writes are every route that is not a GET', () => {
    for (const route of BILLING_ROUTES) expect(route.write).toBe(route.method !== 'GET');
  });
});

describe('schemas refuse', () => {
  it('a currency other than usd', () => {
    const [plan] = PLANS;
    expect(
      BILLING_ROUTES.find((r) => r.name === 'plans')?.response?.safeParse({
        plans: [{ ...plan, currency: 'eur' }],
      }).success,
    ).toBe(false);
  });

  it('an organization id that is not one', () => {
    expect(billingSummarySchema.safeParse({ ...summary, organizationId: 'org_1' }).success).toBe(
      false,
    );
  });

  it('a project id that is not one', () => {
    const route = BILLING_ROUTES.find((r) => r.name === 'setKeepEditable');
    expect(route?.request?.safeParse({ keepEditable: ['x'] }).success).toBe(false);
  });

  it('a redirect that is not https', () => {
    expect(
      planChangeResultSchema.safeParse({ kind: 'redirect', url: 'http://checkout.example.com' })
        .success,
    ).toBe(false);
    expect(
      planChangeResultSchema.safeParse({ kind: 'redirect', url: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });

  it('a page size other than 10 or 25', () => {
    expect(invoicesQuerySchema.safeParse({ limit: 11 }).success).toBe(false);
    expect(invoicesQuerySchema.safeParse({ limit: 25 }).success).toBe(true);
  });

  it('a malformed email or country', () => {
    expect(updateDetailsRequestSchema.safeParse({ billingEmail: 'nope', address }).success).toBe(
      false,
    );
    expect(
      updateDetailsRequestSchema.safeParse({
        billingEmail: 'a@example.com',
        address: { ...address, country: 'ng' },
      }).success,
    ).toBe(false);
  });

  it('an unknown error code', () => {
    expect(
      errorBodySchema.safeParse({ error: { code: 'billing.nope', message: 'x' } }).success,
    ).toBe(false);
    expect(
      errorBodySchema.safeParse({ error: { code: 'billing.same_plan', message: 'x' } }).success,
    ).toBe(true);
  });

  it('an idempotency key that is short, long or has odd characters', () => {
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('k'.repeat(201)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse('plan change 1').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('plan:change-1_a.b').success).toBe(true);
  });

  it('a pending change on a tier that does not exist', () => {
    expect(
      billingSummarySchema.safeParse({
        ...summary,
        pendingChange: { tier: 'platinum', interval: 'month', effectiveAt: NOW },
      }).success,
    ).toBe(false);
  });
});

describe('schemas allow growth', () => {
  it('ignore fields a newer provider adds', () => {
    const parsed = billingSummarySchema.parse({ ...summary, somethingNew: true });
    expect(parsed).toEqual(summary);
  });
});
