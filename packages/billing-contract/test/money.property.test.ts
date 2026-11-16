import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  billingSummarySchema,
  centsSchema,
  invoiceRowSchema,
  planChangePreviewSchema,
  planOptionSchema,
} from '../src/index.ts';
import { ORG } from './support.ts';

const notCents = fc.oneof(
  fc.double({ noNaN: false }).filter((n) => !Number.isSafeInteger(n) || n < 0),
  fc.integer({ max: -1 }),
  fc.constantFrom(
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER * 4,
    -0.5,
    0.1,
    19.99,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ),
  fc.string().map((s) => `${s}1`),
  fc.bigInt(),
);

const cents = fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER });
const iso = fc
  .date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date('2100-01-01T00:00:00Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

// Each object that carries money, with every *Cents field it has.
const carriers = [
  {
    name: 'PlanOption',
    schema: planOptionSchema,
    base: { tier: 'starter', interval: 'month', amountCents: 0, currency: 'usd' },
  },
  {
    name: 'PlanChangePreview',
    schema: planChangePreviewSchema,
    base: {
      kind: 'upgrade',
      effective: 'now',
      effectiveAt: '2030-01-01T00:00:00.000Z',
      dueNowCents: 0,
      nextInvoiceCents: 0,
      currency: 'usd',
    },
  },
  {
    name: 'InvoiceRow',
    schema: invoiceRowSchema,
    base: {
      invoiceId: 'inv_1',
      number: 'A-1',
      status: 'open',
      amountDueCents: 0,
      amountPaidCents: 0,
      currency: 'usd',
      createdAt: '2030-01-01T00:00:00.000Z',
    },
  },
] as const;

describe('money fields', () => {
  it('accept every non negative safe integer', () => {
    fc.assert(
      fc.property(cents, (value) => {
        expect(centsSchema.parse(value)).toBe(value);
      }),
    );
  });

  it('refuse floats, negatives, unsafe integers and anything that is not a number', () => {
    fc.assert(
      fc.property(notCents, (value) => {
        expect(centsSchema.safeParse(value).success).toBe(false);
      }),
    );
  });

  for (const { name, schema, base } of carriers) {
    const fields = Object.keys(base).filter((key) => key.endsWith('Cents'));

    it(`${name} has money fields to check`, () => {
      expect(fields.length).toBeGreaterThan(0);
    });

    it(`${name} refuses a bad value in any *Cents field`, () => {
      fc.assert(
        fc.property(fc.constantFrom(...fields), notCents, (field, value) => {
          expect(schema.safeParse({ ...base, [field]: value }).success).toBe(false);
        }),
      );
    });

    it(`${name} round trips any valid amounts`, () => {
      fc.assert(
        fc.property(
          fc.array(cents, { minLength: fields.length, maxLength: fields.length }),
          (amounts) => {
            const value: Record<string, unknown> = { ...base };
            fields.forEach((field, i) => {
              value[field] = amounts[i];
            });
            expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
          },
        ),
      );
    });
  }
});

const tier = fc.constantFrom('free', 'starter', 'growth', 'scale', 'enterprise', 'self_hosted');
const interval = fc.constantFrom('month', 'year');
const text = fc.string({ minLength: 1, maxLength: 20 });

const summary = fc.record({
  organizationId: fc.constant(ORG),
  plan: fc.record({
    tier,
    interval: fc.option(interval, { nil: null }),
    status: fc.constantFrom('none', 'active', 'past_due', 'canceled', 'contract'),
    currentPeriodEnd: fc.option(iso, { nil: null }),
    pastDueRestrictsOn: fc.option(iso, { nil: null }),
  }),
  pendingChange: fc.option(fc.record({ tier, interval, effectiveAt: iso }), { nil: null }),
  paymentMethod: fc.option(
    fc.record({
      brand: text,
      last4: fc.stringMatching(/^\d{4}$/),
      expMonth: fc.integer({ min: 1, max: 12 }),
      expYear: fc.integer({ min: 2000, max: 2100 }),
    }),
    { nil: null },
  ),
  billingEmail: fc.option(fc.constantFrom('a@example.com', 'billing@example.org'), { nil: null }),
  address: fc.option(
    fc.record({
      line1: text,
      line2: fc.option(text, { nil: null }),
      city: text,
      state: fc.option(text, { nil: null }),
      postalCode: fc.option(text, { nil: null }),
      country: fc.stringMatching(/^[A-Z]{2}$/),
    }),
    { nil: null },
  ),
  taxIds: fc.array(
    fc.record({
      id: text,
      type: fc.constantFrom('eu_vat', 'gb_vat', 'us_ein', 'ca_gst_hst'),
      value: text,
      verification: fc.constantFrom('pending', 'verified', 'unverified', 'unavailable'),
    }),
    { maxLength: 5 },
  ),
});

describe('BillingSummary', () => {
  it('round trips any valid summary', () => {
    fc.assert(
      fc.property(summary, (value) => {
        expect(billingSummarySchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
      }),
    );
  });
});
