import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TIERS } from '@drefyn/entitlements';
import type { Tier } from '@drefyn/entitlements';
import { userId } from '@drefyn/tenancy';
import type { OrganizationId, ProjectId, UserId } from '@drefyn/tenancy';
import { z } from 'zod';
import { BILLING_ERROR_STATUS } from './errors.ts';
import type { BillingErrorCode } from './errors.ts';
import {
  BILLING_BASE_PATH,
  MAX_BODY_BYTES,
  addTaxIdRequestSchema,
  changePlanRequestSchema,
  idempotencyKeySchema,
  invoiceLinkRequestSchema,
  invoicesQuerySchema,
  keepEditableRequestSchema,
  organizationIdSchema,
  planOptionSchema,
  previewRequestSchema,
  updateDetailsRequestSchema,
} from './schemas.ts';
import type {
  BillingSummary,
  Interval,
  InvoiceRow,
  PlanChangePreview,
  PlanChangeResult,
  PlanOption,
  TargetTier,
} from './schemas.ts';

// An in memory billing provider for tests and e2e runs. It speaks /billing/v1 over real
// HTTP on loopback, so the client, the dashboard and the contract suite meet the same
// wire format a hosted provider serves. It holds no prices: plans come from the caller.

export type FakeScenario =
  | 'active'
  | 'no_card'
  | 'card_expiring'
  | 'past_due'
  | 'scheduled_downgrade'
  | 'declined_upgrade'
  | 'contract'
  | 'unavailable'
  | 'slow'
  | 'malformed'
  | 'oversized';

export interface FakeBillingOptions {
  readonly token: string;
  readonly plans: readonly PlanOption[];
  // Owners may write; owners and admins may read. Everyone else is refused.
  readonly owners: readonly UserId[];
  readonly admins?: readonly UserId[];
  readonly scenario?: FakeScenario;
  // The fake's clock, so every date it answers is reproducible.
  readonly now?: string;
  readonly slowMs?: number;
  // How many projects a downgrade may keep editable.
  readonly keepLimit?: number;
  readonly invoiceCount?: number;
  readonly maxIdempotencyKeys?: number;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly actor: string | null;
  readonly idempotencyKey: string | null;
  // Whether a bearer token came; the token itself is never kept.
  readonly bearer: boolean;
}

export interface FakeBillingProvider {
  readonly url: string;
  // Also forgets every organization's state, recorded request and idempotency key.
  setScenario(scenario: FakeScenario): void;
  requests(): readonly RecordedRequest[];
  close(): Promise<void>;
}

const optionsSchema = z.object({
  token: z.string().min(1),
  plans: z.array(planOptionSchema).min(1),
  owners: z.array(z.string()),
  admins: z.array(z.string()).default([]),
  now: z.iso.datetime().default('2030-01-15T00:00:00.000Z'),
  slowMs: z.int().min(0).max(600_000).default(5000),
  keepLimit: z.int().min(0).default(3),
  invoiceCount: z.int().min(0).max(1000).default(30),
  maxIdempotencyKeys: z.int().min(1).default(1000),
});

const MAX_RECORDED = 200;
const DAY_MS = 86_400_000;
const ORG_ROUTE = new RegExp(`^${BILLING_BASE_PATH}/orgs/([^/]+)(/.*)$`);

interface OrgState {
  tier: Tier;
  interval: Interval | null;
  status: BillingSummary['plan']['status'];
  // Always set, so a scheduled change has a date; Free shows none.
  currentPeriodEnd: string;
  pastDueRestrictsOn: string | null;
  pendingChange: BillingSummary['pendingChange'];
  keepEditable: readonly ProjectId[];
  paymentMethod: BillingSummary['paymentMethod'];
  billingEmail: string | null;
  address: BillingSummary['address'];
  taxIds: BillingSummary['taxIds'];
  nextTaxId: number;
}

interface Answer {
  readonly status: number;
  readonly body?: unknown;
  // Sent as is, for answers that are not JSON at all.
  readonly raw?: string;
}

class Refusal extends Error {
  readonly code: BillingErrorCode;

  constructor(code: BillingErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const refuse = (code: BillingErrorCode, message: string): Answer => ({
  status: BILLING_ERROR_STATUS[code],
  body: { error: { code, message } },
});

const rank = (tier: Tier) => TIERS.indexOf(tier);

export async function startFakeBillingProvider(
  options: FakeBillingOptions,
): Promise<FakeBillingProvider> {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`fake billing options: invalid ${fields}`);
  }
  const config = parsed.data;
  const owners = new Set(config.owners);
  const admins = new Set(config.admins);
  const now = Date.parse(config.now);
  const at = (days: number) => new Date(now + days * DAY_MS).toISOString();

  let scenario = options.scenario ?? 'active';
  let states = new Map<OrganizationId, OrgState>();
  let recorded: RecordedRequest[] = [];
  let answered = new Map<string, { fingerprint: string; answer: Answer }>();
  const timers = new Set<NodeJS.Timeout>();

  const amountOf = (tier: Tier, interval: Interval | null) =>
    config.plans.find((plan) => plan.tier === tier && plan.interval === interval)?.amountCents ?? 0;

  function fresh(): OrgState {
    const card = {
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: new Date(now).getUTCFullYear() + 3,
    };
    const state: OrgState = {
      tier: 'starter',
      interval: 'month',
      status: 'active',
      currentPeriodEnd: at(30),
      pastDueRestrictsOn: null,
      pendingChange: null,
      keepEditable: [],
      paymentMethod: card,
      billingEmail: null,
      address: null,
      taxIds: [],
      nextTaxId: 1,
    };
    switch (scenario) {
      case 'no_card':
        return { ...state, tier: 'free', interval: null, status: 'none', paymentMethod: null };
      case 'card_expiring': {
        const date = new Date(now);
        return {
          ...state,
          paymentMethod: {
            ...card,
            expMonth: date.getUTCMonth() + 1,
            expYear: date.getUTCFullYear(),
          },
        };
      }
      case 'past_due':
        return { ...state, status: 'past_due', pastDueRestrictsOn: at(14) };
      case 'scheduled_downgrade':
        return {
          ...state,
          tier: 'growth',
          pendingChange: { tier: 'starter', interval: 'month', effectiveAt: at(30) },
        };
      case 'contract':
        return { ...state, tier: 'enterprise', interval: null, status: 'contract' };
      default:
        return state;
    }
  }

  const stateOf = (org: OrganizationId) => {
    let state = states.get(org);
    if (state === undefined) {
      state = fresh();
      states.set(org, state);
    }
    return state;
  };

  const summaryOf = (org: OrganizationId): BillingSummary => {
    const s = stateOf(org);
    return {
      organizationId: org,
      plan: {
        tier: s.tier,
        interval: s.interval,
        status: s.status,
        currentPeriodEnd: s.status === 'none' ? null : s.currentPeriodEnd,
        pastDueRestrictsOn: s.pastDueRestrictsOn,
      },
      pendingChange: s.pendingChange,
      paymentMethod: s.paymentMethod,
      billingEmail: s.billingEmail,
      address: s.address,
      taxIds: s.taxIds,
    };
  };

  function classify(
    s: OrgState,
    target: { tier: TargetTier; interval: Interval },
  ): Pick<PlanChangePreview, 'kind' | 'effective'> {
    if (s.status === 'contract') {
      throw new Refusal('billing.contract_plan', 'Enterprise plans change through the contract.');
    }
    const step = rank(target.tier) - rank(s.tier);
    if (step === 0 && (s.interval === null || s.interval === target.interval)) {
      throw new Refusal('billing.same_plan', 'That is the current plan.');
    }
    if (step > 0) return { kind: 'upgrade', effective: 'now' };
    if (step < 0) return { kind: 'downgrade', effective: 'period_end' };
    return {
      kind: 'interval_change',
      effective: target.interval === 'year' ? 'now' : 'period_end',
    };
  }

  const checkKeep = (keep: readonly ProjectId[]) => {
    if (keep.length > config.keepLimit) {
      throw new Refusal('billing.keep_over_limit', 'More projects kept than the plan allows.');
    }
  };

  const invoicesOf = (org: OrganizationId): InvoiceRow[] => {
    const s = stateOf(org);
    const amount = amountOf(s.tier, s.interval);
    return Array.from({ length: config.invoiceCount }, (_, i) => {
      const open = i === 0 && s.status === 'past_due';
      const n = String(config.invoiceCount - i).padStart(4, '0');
      return {
        invoiceId: `inv_fake_${n}`,
        number: `FAKE-${n}`,
        status: open ? 'open' : 'paid',
        amountDueCents: amount,
        amountPaidCents: open ? 0 : amount,
        currency: 'usd',
        createdAt: at(-30 * i),
      };
    });
  };

  const body = <T extends z.ZodType>(schema: T, value: unknown): z.output<T> => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const fields = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
      throw new Refusal('billing.invalid_input', `invalid input: ${fields}`);
    }
    return result.data;
  };

  // Each handler answers one route for one organization. Throwing a Refusal answers with
  // its code.
  function route(
    method: string,
    rest: string,
    org: OrganizationId,
    input: unknown,
    query: URLSearchParams,
  ): Answer {
    const s = stateOf(org);
    if (method === 'GET' && rest === '/summary') return { status: 200, body: summaryOf(org) };

    if (method === 'POST' && rest === '/plan-changes/preview') {
      const target = body(previewRequestSchema, input);
      const { kind, effective } = classify(s, target);
      const next = amountOf(target.tier, target.interval);
      const preview: PlanChangePreview = {
        kind,
        effective,
        effectiveAt: effective === 'now' ? config.now : s.currentPeriodEnd,
        dueNowCents: effective === 'now' ? Math.max(0, next - amountOf(s.tier, s.interval)) : 0,
        nextInvoiceCents: next,
        currency: 'usd',
      };
      return { status: 200, body: preview };
    }

    if (method === 'POST' && rest === '/plan-changes') {
      const change = body(changePlanRequestSchema, input);
      const { effective } = classify(s, change);
      let result: PlanChangeResult;
      if (effective === 'now') {
        // An upgrade replaces a pending downgrade.
        s.pendingChange = null;
        if (s.paymentMethod === null) {
          result = { kind: 'redirect', url: `https://checkout.fake.invalid/session/${org}` };
        } else if (scenario === 'declined_upgrade') {
          result = { kind: 'declined', reason: 'card_declined' };
        } else {
          // A real provider confirms payment later; the fake confirms at once.
          s.tier = change.tier;
          s.interval = change.interval;
          s.status = 'active';
          result = { kind: 'pending_payment' };
        }
      } else {
        if (s.pendingChange !== null) {
          throw new Refusal('billing.pending_change_exists', 'Cancel the scheduled change first.');
        }
        checkKeep(change.keepEditable);
        const effectiveAt = s.currentPeriodEnd;
        s.pendingChange = { tier: change.tier, interval: change.interval, effectiveAt };
        s.keepEditable = change.keepEditable;
        result = { kind: 'scheduled', effectiveAt };
      }
      return { status: 200, body: result };
    }

    if (method === 'DELETE' && rest === '/plan-changes/pending') {
      s.pendingChange = null;
      return { status: 204 };
    }

    if (method === 'PUT' && rest === '/keep-editable') {
      const { keepEditable } = body(keepEditableRequestSchema, input);
      checkKeep(keepEditable);
      s.keepEditable = keepEditable;
      return { status: 204 };
    }

    if (method === 'POST' && rest === '/payment-method/session') {
      return { status: 200, body: { url: `https://checkout.fake.invalid/setup/${org}` } };
    }

    if (method === 'PUT' && rest === '/details') {
      const details = body(updateDetailsRequestSchema, input);
      s.billingEmail = details.billingEmail;
      s.address = details.address;
      return { status: 200, body: summaryOf(org) };
    }

    if (method === 'POST' && rest === '/tax-ids') {
      const taxId = body(addTaxIdRequestSchema, input);
      if (!/^[A-Z0-9]{4,20}$/i.test(taxId.value)) {
        throw new Refusal('billing.tax_id_invalid', 'That tax id does not match its format.');
      }
      s.taxIds = [...s.taxIds, { id: `txi_${s.nextTaxId}`, ...taxId, verification: 'pending' }];
      s.nextTaxId += 1;
      return { status: 200, body: summaryOf(org) };
    }

    const taxId = /^\/tax-ids\/([^/]+)$/.exec(rest)?.[1];
    if (method === 'DELETE' && taxId !== undefined) {
      const id = decodeURIComponent(taxId);
      s.taxIds = s.taxIds.filter((item) => item.id !== id);
      return { status: 200, body: summaryOf(org) };
    }

    if (method === 'GET' && rest === '/invoices') {
      const page = body(invoicesQuerySchema, {
        cursor: query.get('cursor') ?? undefined,
        limit: Number(query.get('limit')),
      });
      const cursor = page.cursor ?? '0';
      if (!/^\d{1,6}$/.test(cursor)) throw new Refusal('billing.invalid_input', 'invalid cursor');
      const start = Number(cursor);
      const all = invoicesOf(org);
      const end = start + page.limit;
      return {
        status: 200,
        body: { items: all.slice(start, end), next: end < all.length ? String(end) : null },
      };
    }

    const invoiceId = /^\/invoices\/([^/]+)\/link$/.exec(rest)?.[1];
    if (method === 'POST' && invoiceId !== undefined) {
      const { purpose } = body(invoiceLinkRequestSchema, input);
      const id = decodeURIComponent(invoiceId);
      if (!invoicesOf(org).some((invoice) => invoice.invoiceId === id)) {
        throw new Refusal('billing.invalid_input', 'unknown invoiceId');
      }
      return { status: 200, body: { url: `https://invoices.fake.invalid/${id}/${purpose}` } };
    }

    return refuse('billing.invalid_input', 'unknown route');
  }

  function write(res: ServerResponse, answer: Answer) {
    if (answer.raw !== undefined) {
      res.writeHead(answer.status, { 'content-type': 'text/plain' }).end(answer.raw);
      return;
    }
    if (answer.body === undefined) {
      res.writeHead(answer.status).end();
      return;
    }
    res
      .writeHead(answer.status, { 'content-type': 'application/json' })
      .end(JSON.stringify(answer.body));
  }

  async function readBody(req: IncomingMessage): Promise<string | undefined> {
    let text = '';
    let bytes = 0;
    let over = false;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES) over = true;
      else text += chunk.toString('utf8');
    }
    return over ? undefined : text;
  }

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        resolve();
      }, ms);
      timers.add(timer);
    });

  async function handle(req: IncomingMessage): Promise<Answer> {
    // Always set on a request a server receives.
    const url = new URL(String(req.url), 'http://fake.invalid');
    const method = String(req.method);
    const header = (name: string) => {
      const value = req.headers[name];
      return typeof value === 'string' ? value : null;
    };
    const actor = header('drefyn-actor');
    const key = header('idempotency-key');
    const authorization = header('authorization');
    recorded.push({
      method,
      path: url.pathname,
      actor,
      idempotencyKey: key,
      bearer: String(authorization).startsWith('Bearer '),
    });
    if (recorded.length > MAX_RECORDED) recorded = recorded.slice(-MAX_RECORDED);

    const text = await readBody(req);

    if (scenario === 'unavailable') {
      return refuse('billing.unavailable', 'Billing details cannot load right now.');
    }
    if (scenario === 'slow') await wait(config.slowMs);
    // Breaks the contract three ways: a success that fails the schema, an error that is
    // not JSON, and a valid error code under the wrong status.
    if (scenario === 'malformed') {
      if (method === 'GET') return { status: 200, body: { unexpected: true } };
      if (method === 'POST') return { status: 500, raw: 'not json' };
      return { ...refuse('billing.invalid_input', 'wrong status'), status: 400 };
    }
    if (scenario === 'oversized')
      return { status: 200, body: { padding: 'x'.repeat(MAX_BODY_BYTES) } };

    if (authorization !== `Bearer ${config.token}`)
      return refuse('billing.forbidden', 'unknown service token');
    let who: UserId;
    try {
      who = userId(String(actor));
    } catch {
      return refuse('billing.forbidden', 'no actor');
    }

    const write = method !== 'GET';
    if (write && !idempotencyKeySchema.safeParse(key).success) {
      return refuse('billing.invalid_input', 'invalid Idempotency-Key');
    }
    if (text === undefined) return refuse('billing.invalid_input', 'body too large');
    let input: unknown;
    if (text !== '') {
      try {
        input = JSON.parse(text);
      } catch {
        return refuse('billing.invalid_input', 'body is not JSON');
      }
    }

    if (method === 'GET' && url.pathname === `${BILLING_BASE_PATH}/plans`) {
      if (!owners.has(who) && !admins.has(who))
        return refuse('billing.forbidden', 'not an owner or admin');
      return { status: 200, body: { plans: config.plans } };
    }

    const match = ORG_ROUTE.exec(url.pathname);
    if (match === null) return refuse('billing.invalid_input', 'unknown route');
    // Both groups always match; the regex has no optional part.
    const org = organizationIdSchema.safeParse(String(match[1]));
    if (!org.success) return refuse('billing.invalid_input', 'invalid organization');
    const rest = String(match[2]);

    // A preview changes nothing, so admins may ask for one.
    const reads = method === 'GET' || rest === '/plan-changes/preview';
    const allowed = owners.has(who) || (reads && admins.has(who));
    if (!allowed) return refuse('billing.forbidden', 'not allowed for this person');

    const fingerprint = `${method} ${url.pathname}${url.search} ${text}`;
    const stored = write && key !== null ? answered.get(`${org.data}|${key}`) : undefined;
    if (stored !== undefined) {
      if (stored.fingerprint !== fingerprint) {
        return refuse('billing.idempotency_conflict', 'Idempotency-Key reused with another body');
      }
      return stored.answer;
    }

    let answer: Answer;
    try {
      answer = route(method, rest, org.data, input, url.searchParams);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      answer = refuse(error.code, error.message);
    }
    if (write && key !== null) {
      answered.set(`${org.data}|${key}`, { fingerprint, answer });
      // Maps keep insertion order, so the first key is the oldest.
      if (answered.size > config.maxIdempotencyKeys) {
        for (const oldest of answered.keys()) {
          answered.delete(oldest);
          break;
        }
      }
    }
    return answer;
  }

  const server = createServer((req, res) => {
    handle(req).then(
      (answer) => {
        write(res, answer);
      },
      () => {
        write(res, refuse('billing.unavailable', 'fake provider failed'));
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  let closed: Promise<void> | undefined;

  return {
    url: `http://127.0.0.1:${port}`,
    setScenario(next) {
      scenario = next;
      states = new Map();
      recorded = [];
      answered = new Map();
    },
    requests: () => [...recorded],
    close() {
      closed ??= new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      return closed;
    },
  };
}
