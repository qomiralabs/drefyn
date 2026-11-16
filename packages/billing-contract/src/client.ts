import { randomUUID } from 'node:crypto';
import { userId } from '@drefyn/tenancy';
import type { OrganizationId, ProjectId, UserRef } from '@drefyn/tenancy';
import { z } from 'zod';
import { BillingError } from './errors.ts';
import {
  BILLING_BASE_PATH,
  MAX_BODY_BYTES,
  addTaxIdRequestSchema,
  billingSummarySchema,
  changePlanRequestSchema,
  errorBodySchema,
  idempotencyKeySchema,
  invoiceLinkRequestSchema,
  invoicePageSchema,
  invoicesQuerySchema,
  keepEditableRequestSchema,
  linkResponseSchema,
  organizationIdSchema,
  planChangePreviewSchema,
  planChangeResultSchema,
  plansResponseSchema,
  previewRequestSchema,
  updateDetailsRequestSchema,
} from './schemas.ts';
import type {
  Address,
  BillingSummary,
  Interval,
  InvoicePage,
  PlanChangePreview,
  PlanChangeResult,
  PlanOption,
  TargetTier,
} from './schemas.ts';

export const ACTOR_HEADER = 'drefyn-actor';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

// The signed in person the dashboard acts for. The provider checks their role itself.
export type ActorRef = UserRef;

export interface BillingClient {
  summary(org: OrganizationId): Promise<BillingSummary>;
  plans(): Promise<readonly PlanOption[]>;
  preview(
    org: OrganizationId,
    target: { readonly tier: TargetTier; readonly interval: Interval },
  ): Promise<PlanChangePreview>;
  changePlan(
    org: OrganizationId,
    input: {
      readonly tier: TargetTier;
      readonly interval: Interval;
      readonly keepEditable: readonly ProjectId[];
      readonly idempotencyKey: string;
    },
  ): Promise<PlanChangeResult>;
  cancelPendingChange(
    org: OrganizationId,
    input: { readonly idempotencyKey: string },
  ): Promise<void>;
  setKeepEditable(
    org: OrganizationId,
    input: { readonly keepEditable: readonly ProjectId[]; readonly idempotencyKey: string },
  ): Promise<void>;
  // A hosted page that collects the card, so card data never touches ours.
  paymentMethodSession(org: OrganizationId): Promise<{ url: string }>;
  updateDetails(
    org: OrganizationId,
    input: { readonly billingEmail: string; readonly address: Address },
  ): Promise<BillingSummary>;
  addTaxId(
    org: OrganizationId,
    input: { readonly type: string; readonly value: string },
  ): Promise<BillingSummary>;
  removeTaxId(org: OrganizationId, input: { readonly id: string }): Promise<BillingSummary>;
  invoices(
    org: OrganizationId,
    input: { readonly cursor?: string; readonly limit: 10 | 25 },
  ): Promise<InvoicePage>;
  invoiceLink(
    org: OrganizationId,
    input: { readonly invoiceId: string; readonly purpose: 'pay' | 'pdf' },
  ): Promise<{ url: string }>;
}

export interface BillingClientOptions {
  readonly baseUrl: string;
  // Secret. Never logged, and only ever sent to baseUrl.
  readonly token: string;
  readonly timeoutMs: number;
  readonly actor: ActorRef;
}

const optionsSchema = z.object({
  baseUrl: z.url({ protocol: /^https?$/ }),
  token: z.string().regex(/^\S{32,4096}$/),
  timeoutMs: z.int().min(1).max(60_000),
  actor: z.object({
    userId: z.string().refine((value) => {
      try {
        userId(value);
        return true;
      } catch {
        return false;
      }
    }),
  }),
});

const invalid = (error: z.ZodError, what: string): BillingError => {
  const fields = error.issues.map((issue) => issue.path.join('.')).join(', ');
  return new BillingError('billing.invalid_input', `${what}: invalid ${fields}`);
};

function check<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid(parsed.error, what);
  return parsed.data;
}

// Reads at most the cap. Past it the answer is treated as no answer.
async function readCapped(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const chunk = read.value as Uint8Array;
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

interface Call<T extends z.ZodType | null> {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly answer: T;
}

export function createBillingClient(options: BillingClientOptions): BillingClient {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) throw invalid(parsed.error, 'billing client options');
  const { token, timeoutMs, actor } = parsed.data;
  const base = parsed.data.baseUrl.replace(/\/+$/, '') + BILLING_BASE_PATH;

  const orgPath = (org: OrganizationId) =>
    `/orgs/${encodeURIComponent(check(organizationIdSchema, org, 'organization'))}`;

  async function send<T extends z.ZodType | null>(
    call: Call<T>,
  ): Promise<T extends z.ZodType ? z.output<T> : undefined> {
    const url = new URL(base + call.path);
    for (const [key, value] of Object.entries(call.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      [ACTOR_HEADER]: actor.userId,
    };
    if (call.method !== 'GET') headers[IDEMPOTENCY_HEADER] = call.idempotencyKey ?? randomUUID();
    if (call.body !== undefined) headers['content-type'] = 'application/json';

    let status: number;
    let text: string | undefined;
    try {
      // The signal also bounds reading the body, so a provider that stalls mid answer
      // still ends inside the timeout.
      const response = await fetch(url, {
        method: call.method,
        headers,
        body: call.body === undefined ? null : JSON.stringify(call.body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = response.status;
      text = await readCapped(response);
    } catch (error) {
      throw new BillingError('billing.unavailable', 'billing provider did not answer', {
        cause: error,
      });
    }
    if (text === undefined) {
      throw new BillingError('billing.unavailable', 'billing provider answer too large');
    }

    if (status >= 200 && status < 300) {
      if (call.answer === null) {
        return undefined as T extends z.ZodType ? z.output<T> : undefined;
      }
      const answer = call.answer.safeParse(parseJson(text));
      if (!answer.success) {
        throw new BillingError(
          'billing.unavailable',
          'billing provider answer failed the contract',
        );
      }
      return answer.data as T extends z.ZodType ? z.output<T> : undefined;
    }
    const error = errorBodySchema.safeParse(parseJson(text));
    if (!error.success) {
      throw new BillingError('billing.unavailable', `billing provider answered ${status}`);
    }
    throw new BillingError(error.data.error.code, error.data.error.message);
  }

  return {
    async summary(org) {
      return await send({
        method: 'GET',
        path: `${orgPath(org)}/summary`,
        answer: billingSummarySchema,
      });
    },
    async plans() {
      const { plans } = await send({ method: 'GET', path: '/plans', answer: plansResponseSchema });
      return plans;
    },
    async preview(org, target) {
      return await send({
        method: 'POST',
        path: `${orgPath(org)}/plan-changes/preview`,
        body: check(previewRequestSchema, target, 'preview'),
        answer: planChangePreviewSchema,
      });
    },
    async changePlan(org, input) {
      const { idempotencyKey, ...body } = input;
      return await send({
        method: 'POST',
        path: `${orgPath(org)}/plan-changes`,
        body: check(changePlanRequestSchema, body, 'plan change'),
        idempotencyKey: check(idempotencyKeySchema, idempotencyKey, 'idempotencyKey'),
        answer: planChangeResultSchema,
      });
    },
    async cancelPendingChange(org, input) {
      await send({
        method: 'DELETE',
        path: `${orgPath(org)}/plan-changes/pending`,
        idempotencyKey: check(idempotencyKeySchema, input.idempotencyKey, 'idempotencyKey'),
        answer: null,
      });
    },
    async setKeepEditable(org, input) {
      const { idempotencyKey, ...body } = input;
      await send({
        method: 'PUT',
        path: `${orgPath(org)}/keep-editable`,
        body: check(keepEditableRequestSchema, body, 'keep editable'),
        idempotencyKey: check(idempotencyKeySchema, idempotencyKey, 'idempotencyKey'),
        answer: null,
      });
    },
    async paymentMethodSession(org) {
      return await send({
        method: 'POST',
        path: `${orgPath(org)}/payment-method/session`,
        answer: linkResponseSchema,
      });
    },
    async updateDetails(org, input) {
      return await send({
        method: 'PUT',
        path: `${orgPath(org)}/details`,
        body: check(updateDetailsRequestSchema, input, 'details'),
        answer: billingSummarySchema,
      });
    },
    async addTaxId(org, input) {
      return await send({
        method: 'POST',
        path: `${orgPath(org)}/tax-ids`,
        body: check(addTaxIdRequestSchema, input, 'tax id'),
        answer: billingSummarySchema,
      });
    },
    async removeTaxId(org, input) {
      const id = check(z.string().min(1).max(100), input.id, 'id');
      return await send({
        method: 'DELETE',
        path: `${orgPath(org)}/tax-ids/${encodeURIComponent(id)}`,
        answer: billingSummarySchema,
      });
    },
    async invoices(org, input) {
      const query = check(invoicesQuerySchema, input, 'invoices');
      return await send({
        method: 'GET',
        path: `${orgPath(org)}/invoices`,
        query: { cursor: query.cursor, limit: String(query.limit) },
        answer: invoicePageSchema,
      });
    },
    async invoiceLink(org, input) {
      const { invoiceId, ...body } = input;
      const id = check(z.string().min(1).max(100), invoiceId, 'invoiceId');
      return await send({
        method: 'POST',
        path: `${orgPath(org)}/invoices/${encodeURIComponent(id)}/link`,
        body: check(invoiceLinkRequestSchema, body, 'invoice link'),
        answer: linkResponseSchema,
      });
    },
  };
}
