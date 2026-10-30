import type { Transaction } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY_EXPIRY_RULES,
  AUTH_EXPIRY_RULES,
  createExpiryCleanup,
  deleteExpired,
  type ExpiryRule,
} from '../src/index.ts';
import { thrown } from './support.ts';

interface TwoTables {
  first: { id: string; expires_at: Date };
  second: { id: string; ended_at: Date | null; started_at: Date; name: string };
}

const RULES: readonly ExpiryRule<TwoTables>[] = [
  { table: 'first', column: 'expires_at', afterSeconds: 86_400 },
  { table: 'second', column: 'ended_at', afterSeconds: 0 },
];

// Validation happens before any SQL, so a transaction that cannot run anything is enough.
const tx = {} as Transaction<TwoTables>;

describe('expiry rules', () => {
  it('clear ended windows and challenges and states a day after expiry', () => {
    expect(AUTH_EXPIRY_RULES).toEqual([
      { table: 'auth_rate_limits', column: 'window_end', afterSeconds: 0 },
      { table: 'email_challenges', column: 'expires_at', afterSeconds: 86_400 },
      { table: 'oauth_states', column: 'expires_at', afterSeconds: 86_400 },
    ]);
    expect(API_KEY_EXPIRY_RULES).toEqual([
      { table: 'api_key_failures', column: 'window_end', afterSeconds: 0 },
    ]);
  });

  it.each<[string, readonly ExpiryRule<TwoTables>[]]>([
    ['a negative age', [{ table: 'first', column: 'expires_at', afterSeconds: -1 }]],
    ['a fractional age', [{ table: 'first', column: 'expires_at', afterSeconds: 1.5 }]],
    [
      'an age past 400 days',
      [{ table: 'first', column: 'expires_at', afterSeconds: 400 * 86_400 + 1 }],
    ],
    ['a rule listed twice', [RULES[0], RULES[0]] as ExpiryRule<TwoTables>[]],
    ['no rule at all', []],
    [
      'a table name that is not an identifier',
      [{ table: 'first; drop' as 'first', column: 'expires_at', afterSeconds: 0 }],
    ],
    [
      'a column name that is not an identifier',
      [{ table: 'first', column: 'expires_at"' as 'expires_at', afterSeconds: 0 }],
    ],
  ])('refuse %s before any SQL', (_label, rules) => {
    expect(
      thrown(() => createExpiryCleanup({ rules, transact: () => Promise.resolve({}) })),
    ).toMatchObject({
      code: 'DB_CONFIG_INVALID',
    });
    return expect(deleteExpired(tx, rules)).rejects.toMatchObject({ code: 'DB_CONFIG_INVALID' });
  });

  it('accept 400 days, the longest a device cookie lives', () => {
    expect(() =>
      createExpiryCleanup({
        rules: [{ table: 'first', column: 'expires_at', afterSeconds: 400 * 86_400 }],
        transact: () => Promise.resolve({}),
      }),
    ).not.toThrow();
  });
});

describe('deleteExpired', () => {
  it('refuses a batch outside 1 to 50000 before any SQL', async () => {
    for (const batchSize of [0, 50_001, 1.5]) {
      await expect(deleteExpired(tx, RULES, { batchSize })).rejects.toMatchObject({
        code: 'DB_CONFIG_INVALID',
      });
    }
  });
});

describe('createExpiryCleanup', () => {
  const ok = { first: 1, second: 2 };

  it('runs at most once a minute per runner', async () => {
    let clock = 1_000_000;
    const transact = vi.fn(() => Promise.resolve(ok));
    const cleanup = createExpiryCleanup({ rules: RULES, transact, now: () => clock });
    expect(await cleanup.maybeRun()).toEqual(ok);
    clock += 59_999;
    expect(await cleanup.maybeRun()).toBeNull();
    clock += 1;
    expect(await cleanup.maybeRun()).toEqual(ok);
    expect(transact).toHaveBeenCalledTimes(2);
  });

  it('runs once for callers that arrive while a run is in flight', async () => {
    let release: (value: typeof ok) => void = () => undefined;
    const transact = vi.fn(
      () =>
        new Promise<typeof ok>((resolve) => {
          release = resolve;
        }),
    );
    const cleanup = createExpiryCleanup({ rules: RULES, transact, now: () => 0 });
    const first = cleanup.maybeRun();
    const second = cleanup.maybeRun();
    release(ok);
    expect(await first).toEqual(ok);
    expect(await second).toBeNull();
    expect(transact).toHaveBeenCalledTimes(1);
  });

  it('reports every count, zero included, in rule order', async () => {
    const counted: [string, number][] = [];
    const cleanup = createExpiryCleanup({
      rules: RULES,
      transact: () => Promise.resolve({ first: 0, second: 3 }),
      onDeleted: (table, count) => counted.push([table, count]),
    });
    await cleanup.maybeRun();
    expect(counted).toEqual([
      ['first', 0],
      ['second', 3],
    ]);
  });

  it('never rejects: a failure is logged without its text and waits for the next minute', async () => {
    let clock = 0;
    const warn = vi.fn();
    const transact = vi.fn(() => Promise.reject(new Error('password=hunter2 in a message')));
    const cleanup = createExpiryCleanup({
      rules: RULES,
      transact,
      now: () => clock,
      logger: { warn },
    });
    expect(await cleanup.maybeRun()).toBeNull();
    expect(warn).toHaveBeenCalledWith('db_expiry_cleanup_failed', { tables: 'first,second' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2');
    expect(await cleanup.maybeRun()).toBeNull();
    expect(transact).toHaveBeenCalledTimes(1);
    clock += 60_000;
    await cleanup.maybeRun();
    expect(transact).toHaveBeenCalledTimes(2);
  });

  it('survives a logger and a counter that throw', async () => {
    const cleanup = createExpiryCleanup({
      rules: RULES,
      transact: () => Promise.reject(new Error('down')),
      logger: {
        warn: () => {
          throw new Error('logger down');
        },
      },
    });
    expect(await cleanup.maybeRun()).toBeNull();
    const counting = createExpiryCleanup({
      rules: RULES,
      transact: () => Promise.resolve(ok),
      onDeleted: () => {
        throw new Error('metrics down');
      },
    });
    expect(await counting.maybeRun()).toEqual(ok);
  });

  it('takes rules registered after the shipped ones', async () => {
    const cleanup = createExpiryCleanup({
      rules: [...RULES, { table: 'second', column: 'started_at', afterSeconds: 400 * 86_400 }],
      transact: () => Promise.resolve(ok),
    });
    expect(cleanup.rules).toHaveLength(3);
  });
});
