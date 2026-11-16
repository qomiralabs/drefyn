import { randomUUID } from 'node:crypto';
import type { OrganizationId, UserId } from '@drefyn/tenancy';
import type { z } from 'zod';
import { BILLING_ERROR_STATUS } from './errors.ts';
import type { BillingErrorCode } from './errors.ts';
import {
  BILLING_BASE_PATH,
  MAX_BODY_BYTES,
  billingSummarySchema,
  errorBodySchema,
  invoicePageSchema,
  linkResponseSchema,
  planChangePreviewSchema,
  plansResponseSchema,
} from './schemas.ts';

// Checks any /billing/v1 provider must pass, over plain HTTP so the provider gets no help
// from the client. The fake runs them in this repo; a hosted provider runs the same list
// against a test organization. They write billing details on that organization and change
// nothing else.

export interface ContractTarget {
  readonly baseUrl: string;
  readonly token: string;
  readonly organizationId: OrganizationId;
  // An owner of the organization, and someone with no role in it.
  readonly owner: UserId;
  readonly outsider: UserId;
  readonly timeoutMs?: number;
}

export interface ContractCheck {
  readonly name: string;
  run(target: ContractTarget): Promise<void>;
}

export interface ContractResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export class ContractViolation extends Error {
  constructor(check: string, detail: string) {
    super(`${check}: ${detail}`);
    this.name = 'ContractViolation';
  }
}

interface Reply {
  readonly status: number;
  readonly json: unknown;
}

interface Ask {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly body?: string;
  readonly token?: string;
  readonly actor?: UserId;
  readonly key?: string | null;
}

async function ask(target: ContractTarget, request: Ask): Promise<Reply> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${request.token ?? target.token}`,
    'drefyn-actor': request.actor ?? target.owner,
  };
  const key = request.key === undefined ? `contract:${randomUUID()}` : request.key;
  if (request.method !== 'GET' && key !== null) headers['idempotency-key'] = key;
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(
    target.baseUrl.replace(/\/+$/, '') + BILLING_BASE_PATH + request.path,
    {
      method: request.method,
      headers,
      body: request.body ?? null,
      redirect: 'error',
      signal: AbortSignal.timeout(target.timeoutMs ?? 5000),
    },
  );
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

const orgPath = (target: ContractTarget) => `/orgs/${encodeURIComponent(target.organizationId)}`;

function ensure(condition: boolean, name: string, detail: string): void {
  if (!condition) throw new ContractViolation(name, detail);
}

function expectAnswer<T extends z.ZodType>(name: string, reply: Reply, schema: T): z.output<T> {
  if (reply.status !== 200) throw new ContractViolation(name, `expected 200, got ${reply.status}`);
  const parsed = schema.safeParse(reply.json);
  if (!parsed.success) throw new ContractViolation(name, 'answer does not match the schema');
  return parsed.data;
}

function expectError(name: string, reply: Reply, codes: readonly BillingErrorCode[]): void {
  const parsed = errorBodySchema.safeParse(reply.json);
  if (!parsed.success)
    throw new ContractViolation(name, `expected an error body, got ${reply.status}`);
  const { code } = parsed.data.error;
  if (!codes.includes(code)) {
    throw new ContractViolation(name, `expected ${codes.join(' or ')}, got ${code}`);
  }
  const status = BILLING_ERROR_STATUS[code];
  ensure(reply.status === status, name, `${code} must answer ${status}, got ${reply.status}`);
}

const details = (email: string) =>
  JSON.stringify({
    billingEmail: email,
    address: {
      line1: '1 Contract Street',
      line2: null,
      city: 'Testville',
      state: null,
      postalCode: '00000',
      country: 'US',
    },
  });

const check = (
  name: string,
  run: (target: ContractTarget, name: string) => Promise<void>,
): ContractCheck => Object.freeze({ name, run: (target: ContractTarget) => run(target, name) });

export const CONTRACT_CHECKS: readonly ContractCheck[] = Object.freeze([
  check('summary answers the schema for the organization asked about', async (t, name) => {
    const summary = expectAnswer(
      name,
      await ask(t, { method: 'GET', path: `${orgPath(t)}/summary` }),
      billingSummarySchema,
    );
    ensure(
      summary.organizationId === t.organizationId,
      name,
      'summary is for another organization',
    );
  }),
  check('plans answers the schema with integer cents in usd', async (t, name) => {
    expectAnswer(name, await ask(t, { method: 'GET', path: '/plans' }), plansResponseSchema);
  }),
  check('a wrong service token is refused as forbidden', async (t, name) => {
    const reply = await ask(t, {
      method: 'GET',
      path: `${orgPath(t)}/summary`,
      token: `wrong-${randomUUID()}`,
    });
    expectError(name, reply, ['billing.forbidden']);
  }),
  check('someone with no role is refused a read and a write', async (t, name) => {
    expectError(
      name,
      await ask(t, { method: 'GET', path: `${orgPath(t)}/summary`, actor: t.outsider }),
      ['billing.forbidden'],
    );
    const write = await ask(t, {
      method: 'PUT',
      path: `${orgPath(t)}/details`,
      body: details('contract@example.com'),
      actor: t.outsider,
    });
    expectError(name, write, ['billing.forbidden']);
  }),
  check('a write without an Idempotency-Key is refused', async (t, name) => {
    const reply = await ask(t, {
      method: 'PUT',
      path: `${orgPath(t)}/details`,
      body: details('contract@example.com'),
      key: null,
    });
    expectError(name, reply, ['billing.invalid_input']);
  }),
  check('a repeated key and body replays the first answer', async (t, name) => {
    const key = `contract:${randomUUID()}`;
    const request = {
      method: 'PUT',
      path: `${orgPath(t)}/details`,
      body: details('contract@example.com'),
      key,
    } as const;
    const first = await ask(t, request);
    const second = await ask(t, request);
    expectAnswer(name, first, billingSummarySchema);
    const same =
      JSON.stringify([first.status, first.json]) === JSON.stringify([second.status, second.json]);
    ensure(same, name, 'the replay answered differently');
  }),
  check('a repeated key with another body is a conflict', async (t, name) => {
    const key = `contract:${randomUUID()}`;
    const path = `${orgPath(t)}/details`;
    expectAnswer(
      name,
      await ask(t, { method: 'PUT', path, body: details('contract@example.com'), key }),
      billingSummarySchema,
    );
    const reply = await ask(t, { method: 'PUT', path, body: details('other@example.com'), key });
    expectError(name, reply, ['billing.idempotency_conflict']);
  }),
  check('a body that fails the schema is invalid input', async (t, name) => {
    const reply = await ask(t, {
      method: 'PUT',
      path: `${orgPath(t)}/details`,
      body: details('not an email'),
    });
    expectError(name, reply, ['billing.invalid_input']);
  }),
  check('a body over 64 KB is refused', async (t, name) => {
    const reply = await ask(t, {
      method: 'PUT',
      path: `${orgPath(t)}/details`,
      body: JSON.stringify({ padding: 'x'.repeat(MAX_BODY_BYTES) }),
    });
    expectError(name, reply, ['billing.invalid_input']);
  }),
  check('the current plan cannot be chosen again', async (t, name) => {
    const summary = expectAnswer(
      name,
      await ask(t, { method: 'GET', path: `${orgPath(t)}/summary` }),
      billingSummarySchema,
    );
    const contract = summary.plan.status === 'contract';
    // Free and Enterprise have no interval; for Free any interval names the same plan, and
    // an Enterprise organization is refused whatever it asks for.
    const free = summary.plan.interval === null;
    const tier = contract ? 'scale' : free ? 'free' : summary.plan.tier;
    const reply = await ask(t, {
      method: 'POST',
      path: `${orgPath(t)}/plan-changes/preview`,
      body: JSON.stringify({ tier, interval: summary.plan.interval ?? 'month' }),
    });
    expectError(name, reply, [contract ? 'billing.contract_plan' : 'billing.same_plan']);
  }),
  check('a preview of another plan answers the schema or a plan refusal', async (t, name) => {
    const reply = await ask(t, {
      method: 'POST',
      path: `${orgPath(t)}/plan-changes/preview`,
      body: JSON.stringify({ tier: 'scale', interval: 'year' }),
    });
    if (reply.status === 200) expectAnswer(name, reply, planChangePreviewSchema);
    else expectError(name, reply, ['billing.same_plan', 'billing.contract_plan']);
  }),
  check('invoices page with 10 or 25 and refuse other sizes', async (t, name) => {
    const path = `${orgPath(t)}/invoices`;
    const page = expectAnswer(
      name,
      await ask(t, { method: 'GET', path: `${path}?limit=10` }),
      invoicePageSchema,
    );
    ensure(page.items.length <= 10, name, 'page is larger than asked');
    expectError(name, await ask(t, { method: 'GET', path: `${path}?limit=11` }), [
      'billing.invalid_input',
    ]);
  }),
  check('the card session is an https link', async (t, name) => {
    expectAnswer(
      name,
      await ask(t, { method: 'POST', path: `${orgPath(t)}/payment-method/session` }),
      linkResponseSchema,
    );
  }),
]);

export async function runContractSuite(target: ContractTarget): Promise<readonly ContractResult[]> {
  const results: ContractResult[] = [];
  // One at a time, so a failure names the check that caused it.
  for (const item of CONTRACT_CHECKS) {
    try {
      await item.run(target);
      results.push({ name: item.name, ok: true });
    } catch (error) {
      results.push({ name: item.name, ok: false, detail: String(error) });
    }
  }
  return results;
}
