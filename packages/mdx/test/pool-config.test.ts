import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parsePoolConfig } from '../src/isolated.ts';

describe('parsePoolConfig', () => {
  it('has defaults that keep a bomb from taking every thread', () => {
    const config = parsePoolConfig({});
    expect(config.timeoutMs).toBe(2_000);
    expect(config.projectThreads).toBeLessThan(config.threads);
    expect(config.projectBudgetMs).toBeLessThan(config.projectWindowMs);
  });

  it('reads the environment', () => {
    expect(
      parsePoolConfig({
        DREFYN_PARSE_TIMEOUT_MS: '750',
        DREFYN_PARSE_WORKER_MEMORY_MB: '128',
        DREFYN_PARSE_THREADS: '4',
        DREFYN_PARSE_QUEUE_MAX: '10',
        DREFYN_PARSE_PROJECT_THREADS: '3',
        DREFYN_PARSE_PROJECT_QUEUE_MAX: '5',
        DREFYN_PARSE_PROJECT_BUDGET_MS: '1000',
        DREFYN_PARSE_PROJECT_WINDOW_MS: '2000',
      }),
    ).toEqual({
      timeoutMs: 750,
      maxMemoryMb: 128,
      threads: 4,
      maxQueued: 10,
      projectThreads: 3,
      maxQueuedPerProject: 5,
      projectBudgetMs: 1_000,
      projectWindowMs: 2_000,
    });
  });

  it.each([
    ['a zero timeout', { DREFYN_PARSE_TIMEOUT_MS: '0' }],
    ['an endless timeout', { DREFYN_PARSE_TIMEOUT_MS: '600001' }],
    ['a timeout in words', { DREFYN_PARSE_TIMEOUT_MS: 'soon' }],
    ['a fractional timeout', { DREFYN_PARSE_TIMEOUT_MS: '1.5' }],
    ['a signed timeout', { DREFYN_PARSE_TIMEOUT_MS: '-1' }],
    ['an empty timeout', { DREFYN_PARSE_TIMEOUT_MS: '' }],
    ['a tiny heap', { DREFYN_PARSE_WORKER_MEMORY_MB: '1' }],
    ['an unbounded heap', { DREFYN_PARSE_WORKER_MEMORY_MB: '1000000' }],
    ['one thread, which a bomb would hold', { DREFYN_PARSE_THREADS: '1' }],
    ['a project allowed every thread', { DREFYN_PARSE_PROJECT_THREADS: '2' }],
    ['no queue', { DREFYN_PARSE_QUEUE_MAX: '0' }],
    ['a project queue over the whole queue', { DREFYN_PARSE_PROJECT_QUEUE_MAX: '65' }],
    ['a budget under one timeout', { DREFYN_PARSE_PROJECT_BUDGET_MS: '1999' }],
    ['a budget it could never spend', { DREFYN_PARSE_PROJECT_BUDGET_MS: '60000' }],
  ])('refuses %s', (_name, env) => {
    expect(() => parsePoolConfig(env)).toThrow();
  });

  it('ignores keys it does not own', () => {
    expect(() => parsePoolConfig({ HOME: '/root', DREFYN_AUTH_SECRET: 'x' })).not.toThrow();
  });

  it('never accepts a config where one project can hold every thread', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 16 }), fc.integer({ min: 1, max: 16 }), (all, one) => {
        const env = {
          DREFYN_PARSE_THREADS: String(all),
          DREFYN_PARSE_PROJECT_THREADS: String(one),
        };
        if (one < all) expect(parsePoolConfig(env).projectThreads).toBe(one);
        else expect(() => parsePoolConfig(env)).toThrow();
      }),
    );
  });
});
