import type { Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import {
  reserveApiKeyFailureWindows,
  reserveAuthRateWindows,
  type ApiKeyLimiterSchema,
  type AuthSchema,
} from '../src/index.ts';

// Every refusal happens before SQL, so a transaction that cannot run anything is enough.
const authTx = {} as Transaction<AuthSchema>;
const apiTx = {} as Transaction<ApiKeyLimiterSchema>;
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
    });
  });

  it('refuse an API key failure key that is not 32 bytes', async () => {
    await expect(
      reserveApiKeyFailureWindows(apiTx, { keyHmac: new Uint8Array(33), windowSeconds: [60] }),
    ).rejects.toMatchObject({ code: 'DB_CONFIG_INVALID' });
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
