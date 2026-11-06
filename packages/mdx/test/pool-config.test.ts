import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT_TIMEOUT_MS, parsePoolConfig } from '../src/pool-config.ts';

describe('parsePoolConfig', () => {
  it('has defaults that keep a bomb from taking every thread', () => {
    const config = parsePoolConfig({});
    expect(config.timeoutMs).toBe(2_000);
    expect(config.printTimeoutMs).toBe(DEFAULT_PRINT_TIMEOUT_MS);
    expect(config.orgThreads).toBeLessThan(config.threads);
    expect(config.maxQueuedPerOrg).toBeLessThan(config.maxQueued);
    expect(config.orgBudgetMs).toBeLessThan(config.windowMs);
    expect(config.projectBudgetMs).toBeLessThanOrEqual(config.orgBudgetMs);
    expect(config.killGraceMs).toBe(2_000);
  });

  it('reads the environment', () => {
    expect(
      parsePoolConfig({
        DREFYN_PARSE_TIMEOUT_MS: '750',
        DREFYN_PARSE_PRINT_TIMEOUT_MS: '900',
        DREFYN_PARSE_WORKER_MEMORY_MB: '128',
        DREFYN_PARSE_THREADS: '4',
        DREFYN_PARSE_QUEUE_MAX: '10',
        DREFYN_PARSE_ORG_THREADS: '3',
        DREFYN_PARSE_PROJECT_THREADS: '2',
        DREFYN_PARSE_ORG_QUEUE_MAX: '7',
        DREFYN_PARSE_PROJECT_QUEUE_MAX: '5',
        DREFYN_PARSE_ORG_BUDGET_MS: '1500',
        DREFYN_PARSE_PROJECT_BUDGET_MS: '1000',
        DREFYN_PARSE_WINDOW_MS: '2000',
        DREFYN_PARSE_KILL_GRACE_MS: '300',
      }),
    ).toEqual({
      timeoutMs: 750,
      printTimeoutMs: 900,
      maxMemoryMb: 128,
      threads: 4,
      maxQueued: 10,
      orgThreads: 3,
      projectThreads: 2,
      maxQueuedPerOrg: 7,
      maxQueuedPerProject: 5,
      orgBudgetMs: 1_500,
      projectBudgetMs: 1_000,
      windowMs: 2_000,
      killGraceMs: 300,
    });
  });

  it.each([
    ['a zero timeout', { DREFYN_PARSE_TIMEOUT_MS: '0' }],
    ['a print limit under the parse limit', { DREFYN_PARSE_PRINT_TIMEOUT_MS: '1999' }],
    ['a print limit past the project budget', { DREFYN_PARSE_PRINT_TIMEOUT_MS: '20001' }],
    ['an endless timeout', { DREFYN_PARSE_TIMEOUT_MS: '600001' }],
    ['a timeout in words', { DREFYN_PARSE_TIMEOUT_MS: 'soon' }],
    ['a fractional timeout', { DREFYN_PARSE_TIMEOUT_MS: '1.5' }],
    ['a signed timeout', { DREFYN_PARSE_TIMEOUT_MS: '-1' }],
    ['an empty timeout', { DREFYN_PARSE_TIMEOUT_MS: '' }],
    ['a tiny heap', { DREFYN_PARSE_WORKER_MEMORY_MB: '1' }],
    ['an unbounded heap', { DREFYN_PARSE_WORKER_MEMORY_MB: '1000000' }],
    ['one thread, which a bomb would hold', { DREFYN_PARSE_THREADS: '1' }],
    ['an organization allowed every thread', { DREFYN_PARSE_ORG_THREADS: '2' }],
    ['a project allowed more than its organization', { DREFYN_PARSE_PROJECT_THREADS: '2' }],
    ['an organization allowed the whole queue', { DREFYN_PARSE_ORG_QUEUE_MAX: '64' }],
    ['a project budget over its organization', { DREFYN_PARSE_PROJECT_BUDGET_MS: '30001' }],
    ['a kill grace of nothing', { DREFYN_PARSE_KILL_GRACE_MS: '0' }],
    ['no queue', { DREFYN_PARSE_QUEUE_MAX: '0' }],
    ['a project queue over its organization', { DREFYN_PARSE_PROJECT_QUEUE_MAX: '33' }],
    ['a budget under one timeout', { DREFYN_PARSE_PROJECT_BUDGET_MS: '1999' }],
    ['a budget it could never spend', { DREFYN_PARSE_ORG_BUDGET_MS: '60000' }],
  ])('refuses %s', (_name, env) => {
    expect(() => parsePoolConfig(env)).toThrow();
  });

  it('ignores keys it does not own', () => {
    expect(() => parsePoolConfig({ HOME: '/root', DREFYN_AUTH_SECRET: 'x' })).not.toThrow();
  });

  it('never accepts a config where one organization can hold every thread', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 16 }), fc.integer({ min: 1, max: 16 }), (all, one) => {
        const env = { DREFYN_PARSE_THREADS: String(all), DREFYN_PARSE_ORG_THREADS: String(one) };
        if (one < all) expect(parsePoolConfig(env).orgThreads).toBe(one);
        else expect(() => parsePoolConfig(env)).toThrow();
      }),
    );
  });
});
