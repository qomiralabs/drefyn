import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { databaseOverPool } from '../src/database.ts';
import {
  reserveApiKeyFailureWindows,
  reserveAuthRateWindows,
  type AuthDatabase,
  type Database,
} from '../src/index.ts';

// Every refusal happens before a connection is opened, so handles that open nothing are
// enough; the message shows the request itself was refused, not the handle.
const authTx = {} as AuthDatabase;
const apiTx = {} as Database;
const KEY = new Uint8Array(32);

describe('rate window requests', () => {
  it.each<[string, { bucket: string; keyHmac: Uint8Array; windowSeconds: readonly number[] }]>([
    ['an empty bucket', { bucket: '', keyHmac: KEY, windowSeconds: [60] }],
    ['an upper case bucket', { bucket: 'Email_send', keyHmac: KEY, windowSeconds: [60] }],
    [
      'a bucket over 63 characters',
      { bucket: `b${'x'.repeat(63)}`, keyHmac: KEY, windowSeconds: [60] },
    ],
    [
      'a key that is not 32 bytes',
      { bucket: 'email_send', keyHmac: new Uint8Array(31), windowSeconds: [60] },
    ],
    ['no window', { bucket: 'email_send', keyHmac: KEY, windowSeconds: [] }],
    ['four windows', { bucket: 'email_send', keyHmac: KEY, windowSeconds: [1, 2, 3, 4] }],
    ['a window of 0 seconds', { bucket: 'email_send', keyHmac: KEY, windowSeconds: [0] }],
    ['a window past 7 days', { bucket: 'email_send', keyHmac: KEY, windowSeconds: [604_801] }],
    ['a fractional window', { bucket: 'email_send', keyHmac: KEY, windowSeconds: [1.5] }],
    ['the same window twice', { bucket: 'email_send', keyHmac: KEY, windowSeconds: [60, 60] }],
  ])('refuse %s', async (_label, request) => {
    await expect(reserveAuthRateWindows(authTx, request)).rejects.toMatchObject({
      code: 'DB_CONFIG_INVALID',
      message: expect.stringContaining('rate window request') as unknown,
    });
  });

  it('refuse an API key failure key that is not 32 bytes', async () => {
    await expect(
      reserveApiKeyFailureWindows(apiTx, { keyHmac: new Uint8Array(33), windowSeconds: [60] }),
    ).rejects.toMatchObject({
      code: 'DB_CONFIG_INVALID',
      message: expect.stringContaining('rate window request') as unknown,
    });
  });

  it('never put the key bytes in the error', async () => {
    const key = new Uint8Array(31).fill(0xab);
    const error = await reserveAuthRateWindows(authTx, {
      bucket: 'email_send',
      keyHmac: key,
      windowSeconds: [60],
    }).catch((e: unknown) => e);
    expect(String(error)).not.toMatch(/ab/i);
  });
});

// A pool that records the one message a reservation sends and answers it.
function recording(kind: 'auth' | 'app', rows: unknown[]) {
  const sent: string[] = [];
  const client = {
    on: () => client,
    removeListener: () => client,
    release: () => undefined,
    query: (text: string) => {
      sent.push(text);
      const ok = (r: unknown[] = []) => ({ command: 'SELECT', rows: r, rowCount: r.length });
      return Promise.resolve([ok(), ok(), ok(), ok(rows), ok()]);
    },
  };
  const pool = { connect: () => Promise.resolve(client) };
  const db = databaseOverPool(pool as unknown as pg.Pool, kind, { statementTimeoutMs: 5000 });
  return { db, sent };
}

describe('the reservation statement', () => {
  const key = new Uint8Array(32).fill(0x5a);

  it('writes only the checked bucket, the key as hex and whole seconds into the text', async () => {
    const { db, sent } = recording('auth', [
      { window_seconds: 86_400, count: 2, retry_after: 50 },
      { window_seconds: 600, count: 7, retry_after: 5 },
    ]);
    const counts = await reserveAuthRateWindows(db as AuthDatabase, {
      bucket: 'email_send_ip',
      keyHmac: key,
      windowSeconds: [600, 86_400],
    });
    expect(counts).toEqual([
      { windowSeconds: 600, count: 7, retryAfterSeconds: 5 },
      { windowSeconds: 86_400, count: 2, retryAfterSeconds: 50 },
    ]);
    const text = sent[0] ?? '';
    expect(text).toContain(`decode('${'5a'.repeat(32)}', 'hex')`);
    expect(text).toContain("select 'email_send_ip', decode(");
    expect(text).toContain('unnest(array[600, 86400]::int[])');
    expect(text).toContain('set local statement_timeout = 1000');
    expect(text.trimEnd().endsWith('commit')).toBe(true);
  });

  it('counts an API key failure in one message with its commit', async () => {
    const { db, sent } = recording('app', [{ window_seconds: 60, count: 1, retry_after: 60 }]);
    const counts = await reserveApiKeyFailureWindows(db as Database, {
      keyHmac: key,
      windowSeconds: [60],
    });
    expect(counts).toEqual([{ windowSeconds: 60, count: 1, retryAfterSeconds: 60 }]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('insert into app.api_key_failures');
    expect(sent[0]).toContain('unnest(array[60]::int[])');
  });
});

const row = (windowSeconds: number) => ({
  window_seconds: windowSeconds,
  count: 1,
  retry_after: 9,
});

describe('the answer to a reservation', () => {
  const key = new Uint8Array(32).fill(0x5a);

  it.each<[string, unknown[]]>([
    ['no rows', []],
    ['too few rows', [row(600)]],
    ['a repeated window', [row(600), row(600)]],
    ['an unknown window', [row(600), row(3600)]],
    ['a window more than asked', [row(600), row(86_400), row(3600)]],
    ['every window plus a repeat', [row(600), row(86_400), row(86_400)]],
  ])('throws when it holds %s', async (_label, rows) => {
    const auth = recording('auth', rows);
    await expect(
      reserveAuthRateWindows(auth.db as AuthDatabase, {
        bucket: 'email_send',
        keyHmac: key,
        windowSeconds: [600, 86_400],
      }),
    ).rejects.toMatchObject({ name: 'DbError', code: 'DB_CONFIG_INVALID' });

    const api = recording('app', rows);
    await expect(
      reserveApiKeyFailureWindows(api.db as Database, {
        keyHmac: key,
        windowSeconds: [600, 86_400],
      }),
    ).rejects.toMatchObject({ name: 'DbError', code: 'DB_CONFIG_INVALID' });
  });

  it('accepts each window once, in any order, and keeps the order asked for', async () => {
    const { db } = recording('auth', [row(3600), row(60), row(600)]);
    const counts = await reserveAuthRateWindows(db as AuthDatabase, {
      bucket: 'email_send',
      keyHmac: key,
      windowSeconds: [60, 600, 3600],
    });
    expect(counts.map((c) => c.windowSeconds)).toEqual([60, 600, 3600]);
  });
});

// A list whose reads disagree, as a Proxy or a getter can arrange: its length passes the
// size check, then the full list is what comes out.
function shortWhenMeasured(full: readonly number[]): readonly number[] {
  let lengthReads = 0;
  return new Proxy([...full], {
    get(target, property, receiver): unknown {
      if (property === Symbol.iterator) return () => target[Symbol.iterator]();
      if (property === 'length' && lengthReads++ < 2) return 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

// Safe for the first iterations and hostile from then on.
function turningHostile(safeReads: number): { list: readonly number[]; reads: () => number } {
  let reads = 0;
  const hostile = ['1]); drop table app.users; --'] as unknown as number[];
  const list = new Proxy([60], {
    get(target, property, receiver): unknown {
      if (property === Symbol.iterator) {
        reads += 1;
        const current = reads <= safeReads ? target : hostile;
        return () => current[Symbol.iterator]();
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { list, reads: () => reads };
}

describe('values that only look right', () => {
  const key = new Uint8Array(32).fill(0x5a);

  it('refuses a bucket that is not a string, whatever it coerces to', async () => {
    const { db, sent } = recording('auth', [row(60)]);
    const error = await reserveAuthRateWindows(db as AuthDatabase, {
      bucket: ['a'] as unknown as string,
      keyHmac: key,
      windowSeconds: [60],
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_CONFIG_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('refuses a windows list that changes between reads', async () => {
    const { db, sent } = recording('auth', [row(1), row(2), row(3), row(4)]);
    const error = await reserveAuthRateWindows(db as AuthDatabase, {
      bucket: 'email_send',
      keyHmac: key,
      windowSeconds: shortWhenMeasured([1, 2, 3, 4]),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_CONFIG_INVALID' });
    expect(sent).toHaveLength(0);
  });

  it('reads the windows once, so what was checked is what is written', async () => {
    const { db, sent } = recording('auth', [row(60)]);
    const { list, reads } = turningHostile(1);
    await reserveAuthRateWindows(db as AuthDatabase, {
      bucket: 'email_send',
      keyHmac: key,
      windowSeconds: list,
    });
    expect(reads()).toBe(1);
    expect(sent[0]).toContain('unnest(array[60]::int[])');
    expect(sent[0]).not.toContain('drop table');
  });

  it('refuses the same changing list for an API key failure', async () => {
    const { db, sent } = recording('app', [row(1), row(2), row(3), row(4)]);
    const error = await reserveApiKeyFailureWindows(db as Database, {
      keyHmac: key,
      windowSeconds: shortWhenMeasured([1, 2, 3, 4]),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'DB_CONFIG_INVALID' });
    expect(sent).toHaveLength(0);
  });
});
