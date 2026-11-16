import { inspect } from 'node:util';
import { userId } from '@drefyn/tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, aesGcmSealer, parseAuthConfig } from '../src/index.ts';
import { UUID_A, UUID_B, base64url, caught, validEnv } from './support.ts';

const MATERIAL = new Uint8Array(32).map((_, i) => 200 - i);
const SECRET = new Uint8Array(20).map((_, i) => 100 + i);
const ALICE = { userId: userId(UUID_A) };
const BOB = { userId: userId(UUID_B) };

// Every way a value could be spelled once it reaches text.
function spellings(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  return [
    buffer.toString('hex'),
    buffer.toString('base64'),
    buffer.toString('base64url'),
    inspect(buffer).slice(8, 40),
    // A Uint8Array printed by inspect or JSON lists its bytes as numbers.
    Array.from(bytes.subarray(0, 8)).join(', '),
    Array.from(bytes.subarray(0, 8)).join(','),
  ];
}

function printed(error: unknown): string {
  return [
    String(error),
    (error as Error).stack ?? '',
    JSON.stringify(error),
    inspect(error, { depth: 10, showHidden: true }),
    inspect((error as Error).cause, { depth: 10, showHidden: true }),
  ].join('\n');
}

describe('second factor key material stays out of logs and errors', () => {
  const output: unknown[] = [];

  beforeEach(() => {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(...args);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    output.length = 0;
  });

  it('a refused open names nothing it was given or holds', () => {
    const sealer = aesGcmSealer([{ id: 'k1', material: MATERIAL }]);
    const row = sealer.seal(SECRET, ALICE);
    const bent = Buffer.from(row.sealed);
    bent[0] = (bent[0] ?? 0) ^ 1;
    for (const work of [
      () => sealer.open(row, BOB),
      () => sealer.open({ ...row, sealed: bent }, ALICE),
      () => sealer.open({ ...row, keyId: 'k9' }, ALICE),
      () => sealer.open({ ...row, nonce: row.nonce.subarray(1) }, ALICE),
    ]) {
      const error = caught(work);
      expect(error).toBeInstanceOf(AuthError);
      expect((error as AuthError).code).toBe('AUTH_UNAVAILABLE');
      const text = printed(error);
      for (const bytes of [MATERIAL, SECRET, row.nonce, row.sealed]) {
        for (const spelling of spellings(bytes)) expect(text).not.toContain(spelling);
      }
    }
    expect(output).toEqual([]);
  });

  it('a sealer and a parsed config print no key material', () => {
    const config = parseAuthConfig({
      ...validEnv(),
      DREFYN_AUTH_TOTP_KEYS: `k1:${base64url(MATERIAL)}`,
    });
    const sealer = aesGcmSealer([{ id: 'k1', material: MATERIAL }]);
    const text = [
      JSON.stringify(config),
      JSON.stringify(sealer),
      inspect(config, { depth: 10, showHidden: true }),
      inspect(sealer, { depth: 10, showHidden: true }),
    ].join('\n');
    for (const spelling of spellings(MATERIAL)) expect(text).not.toContain(spelling);
    expect(output).toEqual([]);
  });
});
