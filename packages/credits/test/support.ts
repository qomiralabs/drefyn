import { organizationId, projectId, type OrganizationRef, type TenantRef } from '@drefyn/tenancy';
import { expect } from 'vitest';
import {
  CreditError,
  createMemoryLedger,
  type CreditEntry,
  type CreditErrorCode,
  type CreditLedger,
} from '../src/index.ts';

// Fixed seed so a failure reproduces on every machine. Raise numRuns locally to hunt.
export const runs = { seed: 12, numRuns: 300 } as const;

// Every ledger test builds its ledger here, so the Postgres store can run the same suite.
export function newLedger(): CreditLedger {
  return createMemoryLedger();
}

export const ORG_A: OrganizationRef = {
  organizationId: organizationId('01928c3e-7a9b-7c3d-8e4f-0123456789ab'),
};
export const ORG_B: OrganizationRef = {
  organizationId: organizationId('01928c3e-7a9b-7c3d-8e4f-0123456789ac'),
};
export const ORG_C: OrganizationRef = {
  organizationId: organizationId('ffffffff-ffff-ffff-ffff-ffffffffffff'),
};

export function tenantOf(org: OrganizationRef, project: string): TenantRef {
  return { organizationId: org.organizationId, projectId: projectId(project) };
}

export const SAFE_MAX = Number.MAX_SAFE_INTEGER;

export const ERROR_CODES = [
  'CREDIT_AMOUNT_INVALID',
  'CREDIT_KEY_INVALID',
  'CREDIT_REASON_INVALID',
  'CREDIT_ORGANIZATION_INVALID',
  'CREDIT_IDEMPOTENCY_CONFLICT',
  'CREDIT_ENTRY_NOT_FOUND',
  'CREDIT_NOT_REVERSIBLE',
  'CREDIT_BALANCE_OVERFLOW',
] as const satisfies readonly CreditErrorCode[];

type Outcome = CreditErrorCode | 'no error' | 'not a CreditError';

export function codeOf(run: () => unknown): Outcome {
  try {
    run();
  } catch (error) {
    return error instanceof CreditError ? error.code : 'not a CreditError';
  }
  return 'no error';
}

export async function asyncCodeOf(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
  } catch (error) {
    return error instanceof CreditError ? error.code : 'not a CreditError';
  }
  return 'no error';
}

export function expectCode(run: () => unknown, code: CreditErrorCode): void {
  expect(codeOf(run)).toBe(code);
}

export async function expectRejects(
  run: () => Promise<unknown>,
  code: CreditErrorCode,
): Promise<void> {
  expect(await asyncCodeOf(run)).toBe(code);
}

// Written apart from the package: credits in are positive, credits out are negative.
export function signed(entry: CreditEntry): number {
  switch (entry.kind) {
    case 'grant':
    case 'reversal':
      return entry.amount;
    case 'spend':
    case 'expiry':
      return 0 - entry.amount;
  }
}

export function sumOf(entries: readonly CreditEntry[]): number {
  return entries.reduce((total, entry) => total + signed(entry), 0);
}

// The ledger's whole observable state for one organization. Generated IDs differ between
// two ledgers, so each entry ID is replaced by its position and a reversal by its target's.
export async function snapshot(
  ledger: CreditLedger,
  org: OrganizationRef,
): Promise<{ balance: number; entries: Record<string, unknown>[] }> {
  const entries = await ledger.entries(org);
  const position = new Map<string, number>(entries.map((entry, index) => [entry.id, index]));
  return {
    balance: await ledger.balance(org),
    entries: entries.map((entry, index) => {
      const copy: Record<string, unknown> = { ...entry, id: index };
      if (entry.kind === 'reversal') copy['reverses'] = position.get(entry.reverses) ?? 'missing';
      return copy;
    }),
  };
}
