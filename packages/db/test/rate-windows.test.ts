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
