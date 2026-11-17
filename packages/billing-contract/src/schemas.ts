import { TIERS } from '@drefyn/entitlements';
import { organizationId, projectId } from '@drefyn/tenancy';
import type { OrganizationId, ProjectId } from '@drefyn/tenancy';
import { z } from 'zod';
import { BILLING_ERROR_CODES } from './errors.ts';

// Response objects drop fields they do not know, so a provider can add optional fields
// without breaking an older dashboard. Anything breaking becomes /billing/v2.

export const BILLING_CONTRACT_VERSION = 1;
export const BILLING_BASE_PATH = '/billing/v1';

// Requests and answers past this are refused at both ends.
export const MAX_BODY_BYTES = 64 * 1024;

// Integer cents only: a float can never be added to a bill.
export const centsSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const currencySchema = z.literal('usd');
export const paidTierSchema = z.enum(['starter', 'growth', 'scale']);
export const tierSchema = z.enum(TIERS);
export const intervalSchema = z.enum(['month', 'year']);
export const targetTierSchema = z.enum(['free', 'starter', 'growth', 'scale']);
const timestamp = z.iso.datetime();

// The dashboard sends people to these, so nothing but https gets through.
const httpsUrl = z.url({ protocol: /^https$/, hostname: z.regexes.domain }).max(2048);

export const organizationIdSchema = z.string().transform((value, ctx): OrganizationId => {
  try {
    return organizationId(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not an organization id' });
    return z.NEVER;
  }
});

export const projectIdSchema = z.string().transform((value, ctx): ProjectId => {
  try {
    return projectId(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'not a project id' });
    return z.NEVER;
  }
});

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,200}$/);

export const addressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullable(),
  city: z.string().min(1).max(100),
  state: z.string().max(100).nullable(),
  postalCode: z.string().max(20).nullable(),
  // ISO 3166 alpha 2, upper case.
  country: z.string().regex(/^[A-Z]{2}$/),
});

export const planOptionSchema = z.object({
  tier: paidTierSchema,
  interval: intervalSchema,
  amountCents: centsSchema,
  currency: currencySchema,
});

export const plansResponseSchema = z.object({ plans: z.array(planOptionSchema).max(50) });

export const billingSummarySchema = z.object({
  organizationId: organizationIdSchema,
  plan: z.object({
    tier: tierSchema,
    // Null on Free and Enterprise.
    interval: intervalSchema.nullable(),
    status: z.enum(['none', 'active', 'past_due', 'canceled', 'contract']),
    currentPeriodEnd: timestamp.nullable(),
    // The stated date; nothing is restricted before it.
    pastDueRestrictsOn: timestamp.nullable(),
  }),
  pendingChange: z
    .object({ tier: tierSchema, interval: intervalSchema, effectiveAt: timestamp })
    .nullable(),
  paymentMethod: z
    .object({
      brand: z.string().min(1).max(40),
      last4: z.string().regex(/^\d{4}$/),
      expMonth: z.int().min(1).max(12),
      expYear: z.int().min(2000).max(9999),
    })
    .nullable(),
  billingEmail: z.email().max(254).nullable(),
  address: addressSchema.nullable(),
  taxIds: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        type: z.string().min(1).max(32),
        value: z.string().min(1).max(64),
        verification: z.enum(['pending', 'verified', 'unverified', 'unavailable']),
      }),
    )
    .max(50),
});

export const previewRequestSchema = z.object({
  tier: targetTierSchema,
  interval: intervalSchema,
});

export const planChangePreviewSchema = z.object({
  kind: z.enum(['upgrade', 'downgrade', 'interval_change']),
  effective: z.enum(['now', 'period_end']),
  effectiveAt: timestamp,
  // The prorated charge for a change that starts now, 0 otherwise.
  dueNowCents: centsSchema,
  nextInvoiceCents: centsSchema,
  currency: currencySchema,
});

const keepEditableSchema = z.array(projectIdSchema).max(1000);

export const changePlanRequestSchema = previewRequestSchema.extend({
  keepEditable: keepEditableSchema,
});

export const planChangeResultSchema = z.discriminatedUnion('kind', [
  // A hosted checkout, for the first upgrade.
  z.object({ kind: z.literal('redirect'), url: httpsUrl }),
  // The card on file was charged; the plan changes when the provider confirms payment.
  z.object({ kind: z.literal('pending_payment') }),
  // A downgrade, or annual to monthly, at the period end.
  z.object({ kind: z.literal('scheduled'), effectiveAt: timestamp }),
  z.object({
    kind: z.literal('declined'),
    reason: z.enum(['card_declined', 'authentication_required']),
    url: httpsUrl.optional(),
  }),
]);

export const keepEditableRequestSchema = z.object({ keepEditable: keepEditableSchema });

export const linkResponseSchema = z.object({ url: httpsUrl });

export const updateDetailsRequestSchema = z.object({
  billingEmail: z.email().max(254),
  address: addressSchema,
});

export const addTaxIdRequestSchema = z.object({
  type: z.string().regex(/^[a-z0-9_]{2,32}$/),
  value: z.string().trim().min(1).max(64),
});

export const invoicesQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.union([z.literal(10), z.literal(25)]),
});

export const invoiceRowSchema = z.object({
  invoiceId: z.string().min(1).max(100),
  number: z.string().min(1).max(100),
  status: z.enum(['paid', 'open', 'uncollectible', 'void']),
  amountDueCents: centsSchema,
  amountPaidCents: centsSchema,
  currency: currencySchema,
  createdAt: timestamp,
});

export const invoicePageSchema = z.object({
  items: z.array(invoiceRowSchema).max(25),
  next: z.string().min(1).max(200).nullable(),
});

export const invoiceLinkRequestSchema = z.object({ purpose: z.enum(['pay', 'pdf']) });

export const errorBodySchema = z.object({
  error: z.object({ code: z.enum(BILLING_ERROR_CODES), message: z.string().max(1000) }),
});

export type Cents = z.output<typeof centsSchema>;
export type Currency = z.output<typeof currencySchema>;
export type PaidTier = z.output<typeof paidTierSchema>;
export type TargetTier = z.output<typeof targetTierSchema>;
export type Interval = z.output<typeof intervalSchema>;
export type Address = z.output<typeof addressSchema>;
export type PlanOption = z.output<typeof planOptionSchema>;
export type BillingSummary = z.output<typeof billingSummarySchema>;
export type PlanChangePreview = z.output<typeof planChangePreviewSchema>;
export type PlanChangeResult = z.output<typeof planChangeResultSchema>;
export type InvoiceRow = z.output<typeof invoiceRowSchema>;
export type InvoicePage = z.output<typeof invoicePageSchema>;
export type ErrorBody = z.output<typeof errorBodySchema>;

export interface BillingRoute {
  readonly name: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  // Under BILLING_BASE_PATH; {org} and {id} are path parameters.
  readonly path: string;
  // A GET carries its request in the query string.
  readonly request: z.ZodType | null;
  // Null when the answer is 204 with no body.
  readonly response: z.ZodType | null;
  readonly write: boolean;
}

const route = (
  name: string,
  method: BillingRoute['method'],
  path: string,
  request: z.ZodType | null,
  response: z.ZodType | null,
): BillingRoute =>
  Object.freeze({ name, method, path, request, response, write: method !== 'GET' });

// The whole of /billing/v1. The client, the fake and the contract suite all read this list.
export const BILLING_ROUTES: readonly BillingRoute[] = Object.freeze([
  route('summary', 'GET', '/orgs/{org}/summary', null, billingSummarySchema),
  route('plans', 'GET', '/plans', null, plansResponseSchema),
  route(
    'preview',
    'POST',
    '/orgs/{org}/plan-changes/preview',
    previewRequestSchema,
    planChangePreviewSchema,
  ),
  route(
    'changePlan',
    'POST',
    '/orgs/{org}/plan-changes',
    changePlanRequestSchema,
    planChangeResultSchema,
  ),
  route('cancelPendingChange', 'DELETE', '/orgs/{org}/plan-changes/pending', null, null),
  route('setKeepEditable', 'PUT', '/orgs/{org}/keep-editable', keepEditableRequestSchema, null),
  route(
    'paymentMethodSession',
    'POST',
    '/orgs/{org}/payment-method/session',
    null,
    linkResponseSchema,
  ),
  route(
    'updateDetails',
    'PUT',
    '/orgs/{org}/details',
    updateDetailsRequestSchema,
    billingSummarySchema,
  ),
  route('addTaxId', 'POST', '/orgs/{org}/tax-ids', addTaxIdRequestSchema, billingSummarySchema),
  route('removeTaxId', 'DELETE', '/orgs/{org}/tax-ids/{id}', null, billingSummarySchema),
  route('invoices', 'GET', '/orgs/{org}/invoices', invoicesQuerySchema, invoicePageSchema),
  route(
    'invoiceLink',
    'POST',
    '/orgs/{org}/invoices/{id}/link',
    invoiceLinkRequestSchema,
    linkResponseSchema,
  ),
]);
