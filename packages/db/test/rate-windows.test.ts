import { describe, expect, it } from 'vitest';
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
