import { organizationId, projectId, userId } from '@drefyn/tenancy';
import type { PlanOption } from '../src/index.ts';
import { startFakeBillingProvider } from '../src/fake.ts';
import type { FakeBillingOptions, FakeBillingProvider } from '../src/fake.ts';

export const ORG = organizationId('0b8f6a6e-3a52-4f0e-9a39-1c2d3e4f5a6b');
export const OWNER = userId('11111111-1111-4111-8111-111111111111');
export const ADMIN = userId('22222222-2222-4222-8222-222222222222');
export const OUTSIDER = userId('33333333-3333-4333-8333-333333333333');
export const PROJECTS = [
  projectId('44444444-4444-4444-8444-444444444441'),
  projectId('44444444-4444-4444-8444-444444444442'),
  projectId('44444444-4444-4444-8444-444444444443'),
  projectId('44444444-4444-4444-8444-444444444444'),
] as const;
export const TOKEN = 'test-service-token-0123456789abcdef0123';
export const NOW = '2030-01-15T00:00:00.000Z';

// Made up amounts: the contract carries whatever the provider answers, never a price list.
export const PLANS: readonly PlanOption[] = [
  { tier: 'starter', interval: 'month', amountCents: 1000, currency: 'usd' },
  { tier: 'starter', interval: 'year', amountCents: 10000, currency: 'usd' },
  { tier: 'growth', interval: 'month', amountCents: 2000, currency: 'usd' },
  { tier: 'growth', interval: 'year', amountCents: 20000, currency: 'usd' },
  { tier: 'scale', interval: 'month', amountCents: 3000, currency: 'usd' },
  { tier: 'scale', interval: 'year', amountCents: 30000, currency: 'usd' },
];

export function fakeOptions(extra: Partial<FakeBillingOptions> = {}): FakeBillingOptions {
  return { token: TOKEN, plans: PLANS, owners: [OWNER], admins: [ADMIN], now: NOW, ...extra };
}

export async function startFake(
  extra: Partial<FakeBillingOptions> = {},
): Promise<FakeBillingProvider> {
  return await startFakeBillingProvider(fakeOptions(extra));
}
