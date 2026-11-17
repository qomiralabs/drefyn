import { afterEach, describe, expect, it } from 'vitest';
import { CONTRACT_CHECKS, ContractViolation, runContractSuite } from '../src/contract-suite.ts';
import type { ContractTarget } from '../src/contract-suite.ts';
import type { FakeBillingProvider, FakeScenario } from '../src/fake.ts';
import { ORG, OUTSIDER, OWNER, TOKEN, startFake } from './support.ts';

let fake: FakeBillingProvider | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const targetOf = (provider: FakeBillingProvider): ContractTarget => ({
  baseUrl: provider.url,
  token: TOKEN,
  organizationId: ORG,
  owner: OWNER,
  outsider: OUTSIDER,
});

describe('contract suite', () => {
  it('has named checks', () => {
    expect(CONTRACT_CHECKS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(CONTRACT_CHECKS.map((check) => check.name)).size).toBe(CONTRACT_CHECKS.length);
  });

  it.each<FakeScenario>([
    'active',
    'no_card',
    'card_expiring',
    'past_due',
    'scheduled_downgrade',
    'declined_upgrade',
    'contract',
  ])('the fake passes every check in the %s state', async (scenario) => {
    fake = await startFake({ scenario });
    const results = await runContractSuite(targetOf(fake));
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results).toHaveLength(CONTRACT_CHECKS.length);
  });

  it.each<FakeScenario>(['malformed', 'unavailable'])(
    'fails a provider in the %s state, so a broken service cannot pass',
    async (scenario) => {
      fake = await startFake({ scenario });
      const results = await runContractSuite(targetOf(fake));
      const failed = results.filter((result) => !result.ok);
      expect(failed.length).toBeGreaterThan(0);
      for (const result of failed) expect(result.detail).toEqual(expect.any(String));
    },
  );

  it('fails every check when nothing answers in time', async () => {
    fake = await startFake({ scenario: 'slow', slowMs: 2000 });
    const results = await runContractSuite({ ...targetOf(fake), timeoutMs: 50 });
    expect(results.every((result) => !result.ok)).toBe(true);
  });

  it('names what broke', () => {
    const violation = new ContractViolation('summary', 'expected 200, got 503');
    expect(violation.message).toBe('summary: expected 200, got 503');
    expect(violation.name).toBe('ContractViolation');
  });
});
