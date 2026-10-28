import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { inspect } from 'node:util';
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  KEY_PURPOSES,
  constantTimeEqual,
  deriveAuthKeys,
  lengthPrefixed,
  parseAuthConfig,
  sha256,
  type AuthKeys,
  type MacPart,
} from '../src/index.ts';
import { base64url, expectAuthError, runs, secretBytes, validEnv } from './support.ts';

const part: fc.Arbitrary<MacPart> = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.uint8Array({ maxLength: 40 }),
);
const parts = fc.array(part, { maxLength: 6 });

const bytesOf = (p: MacPart) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p));

// The derivation is written out again here so a change to labels or salt, which would
// orphan every stored code HMAC and rate limit key, fails this file.
function reference(secret: Uint8Array, purpose: string, input: readonly MacPart[]): Buffer {
  const key = Buffer.from(
    hkdfSync('sha256', secret, 'drefyn.auth.hkdf.v1', `drefyn/auth/v1/${purpose}`, 32),
  );
  const framed = Buffer.concat(
    input.flatMap((p) => {
      const bytes = bytesOf(p);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return [length, bytes];
    }),
  );
  return createHmac('sha256', key).update(framed).digest();
}

describe('lengthPrefixed', () => {
  it('frames each part with a 4 byte big endian length', () => {
    expect(lengthPrefixed(['ab', new Uint8Array([1])]).toString('hex')).toBe(
      '000000026162' + '0000000101',
    );
    expect(lengthPrefixed([])).toHaveLength(0);
  });

  it('never gives two different part lists the same bytes', () => {
    fc.assert(
      fc.property(parts, parts, (a, b) => {
        const same =
          a.length === b.length && a.every((p, i) => bytesOf(p).equals(bytesOf(b[i] ?? '')));
        expect(lengthPrefixed(a).equals(lengthPrefixed(b))).toBe(same);
      }),
      runs,
    );
  });

  it('keeps ("ab", "c") apart from ("a", "bc") and ("a", "") apart from ("a")', () => {
    expect(lengthPrefixed(['ab', 'c']).equals(lengthPrefixed(['a', 'bc']))).toBe(false);
    expect(lengthPrefixed(['a', '']).equals(lengthPrefixed(['a']))).toBe(false);
  });
});

describe('deriveAuthKeys', () => {
  it('matches the HKDF and HMAC reference for every purpose', () => {
    fc.assert(
      fc.property(
        secretBytes,
        fc.constantFrom(...KEY_PURPOSES),
        parts,
        (secret, purpose, input) => {
          const keys = deriveAuthKeys(secret);
          expect(keys.mac(purpose, input).equals(reference(secret, purpose, input))).toBe(true);
        },
      ),
      runs,
    );
  });

  it('gives each purpose its own subkey', () => {
    fc.assert(
      fc.property(secretBytes, parts, (secret, input) => {
        const keys = deriveAuthKeys(secret);
        const macs = KEY_PURPOSES.map((purpose) => keys.mac(purpose, input).toString('hex'));
        expect(new Set(macs).size).toBe(KEY_PURPOSES.length);
      }),
      runs,
    );
    expect(KEY_PURPOSES).toEqual(['code', 'rate', 'csrf']);
  });

  it('makes ("ab","c") and ("a","bc") differ under every purpose', () => {
    const keys = deriveAuthKeys(new Uint8Array(32).fill(3));
    for (const purpose of KEY_PURPOSES) {
      expect(keys.mac(purpose, ['ab', 'c']).equals(keys.mac(purpose, ['a', 'bc']))).toBe(false);
    }
  });

  it('gives different secrets different macs', () => {
    fc.assert(
      fc.property(secretBytes, secretBytes, parts, (a, b, input) => {
        fc.pre(!Buffer.from(a).equals(Buffer.from(b)));
        expect(
          deriveAuthKeys(a).mac('code', input).equals(deriveAuthKeys(b).mac('code', input)),
        ).toBe(false);
      }),
      runs,
    );
  });

  it('verifies its own mac and refuses a changed byte, a short value and a long value', () => {
    fc.assert(
      fc.property(secretBytes, parts, fc.nat({ max: 31 }), (secret, input, at) => {
        const keys = deriveAuthKeys(secret);
        for (const purpose of ['code', 'csrf'] as const) {
          const mac = keys.mac(purpose, input);
          expect(keys.verify(purpose, input, mac)).toBe(true);
          const changed = Buffer.from(mac);
          changed[at] = (changed[at] ?? 0) ^ 1;
          expect(keys.verify(purpose, input, changed)).toBe(false);
          expect(keys.verify(purpose, input, mac.subarray(0, 31))).toBe(false);
          expect(keys.verify(purpose, input, Buffer.concat([mac, Buffer.alloc(1)]))).toBe(false);
          expect(keys.verify(purpose, input, new Uint8Array(0))).toBe(false);
        }
        expect(keys.verify('code', input, keys.mac('csrf', input))).toBe(false);
      }),
      { ...runs, numRuns: 100 },
    );
  });

  it('verifies a mac made with the previous secret only while that secret is configured', () => {
    fc.assert(
      fc.property(secretBytes, secretBytes, parts, (oldSecret, newSecret, input) => {
        fc.pre(!Buffer.from(oldSecret).equals(Buffer.from(newSecret)));
        const before = deriveAuthKeys(oldSecret);
        const code = before.mac('code', input);
        const csrf = before.mac('csrf', input);

        const rotating = deriveAuthKeys(newSecret, oldSecret);
        expect(rotating.rotating).toBe(true);
        expect(rotating.verify('code', input, code)).toBe(true);
        expect(rotating.verify('csrf', input, csrf)).toBe(true);
        // New values are always made with the current secret.
        expect(
          rotating.mac('code', input).equals(deriveAuthKeys(newSecret).mac('code', input)),
        ).toBe(true);

        const after = deriveAuthKeys(newSecret);
        expect(after.rotating).toBe(false);
        expect(after.verify('code', input, code)).toBe(false);
        expect(after.verify('csrf', input, csrf)).toBe(false);
      }),
      { ...runs, numRuns: 100 },
    );
  });

  it('follows DREFYN_AUTH_SECRET_PREVIOUS through parseAuthConfig', () => {
    const oldSecret = new Uint8Array(32).fill(1);
    const newSecret = new Uint8Array(32).fill(2);
    const input = ['challenge', 'sign_in', '12345678'];
    const code = parseAuthConfig(validEnv(base64url(oldSecret))).keys.mac('code', input);

    const during = parseAuthConfig({
      ...validEnv(base64url(newSecret)),
      DREFYN_AUTH_SECRET_PREVIOUS: base64url(oldSecret),
    });
    expect(during.keys.verify('code', input, code)).toBe(true);

    const afterwards = parseAuthConfig(validEnv(base64url(newSecret)));
    expect(afterwards.keys.verify('code', input, code)).toBe(false);
  });

  it('refuses secrets under 32 bytes and copies the secret it was given', () => {
    expectAuthError(() => deriveAuthKeys(new Uint8Array(31)), 'AUTH_CONFIG_INVALID');
    expectAuthError(
      () => deriveAuthKeys(new Uint8Array(32), new Uint8Array(4)),
      'AUTH_CONFIG_INVALID',
    );
    const secret = new Uint8Array(32).fill(5);
    const keys = deriveAuthKeys(secret);
    const before = keys.mac('code', ['x']);
    secret.fill(6);
    expect(keys.mac('code', ['x']).equals(before)).toBe(true);
  });

  it('shows no key material when serialised or inspected', () => {
    const secret = new Uint8Array(32).fill(0xab);
    const keys = deriveAuthKeys(secret, new Uint8Array(32).fill(0xcd));
    const text = `${JSON.stringify(keys)}\n${inspect(keys, { showHidden: true, depth: 10 })}`;
    expect(text).not.toMatch(/abab|cdcd|q6ur|zc3n/i);
    expect(JSON.parse(JSON.stringify(keys))).toEqual({ rotating: true });
  });

  it('has no way to verify a rate limit key, which is a lookup and not a proof', () => {
    expectTypeOf<AuthKeys['verify']>().parameter(0).toEqualTypeOf<'code' | 'csrf'>();
  });
});

describe('constantTimeEqual', () => {
  it('is true exactly when the bytes are equal, whatever the lengths', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 48 }), fc.uint8Array({ maxLength: 48 }), (a, b) => {
        expect(constantTimeEqual(a, b)).toBe(Buffer.from(a).equals(Buffer.from(b)));
        expect(constantTimeEqual(a, Uint8Array.from(a))).toBe(true);
      }),
      runs,
    );
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });
});

describe('sha256', () => {
  it('hashes strings as UTF-8 and bytes as they are', () => {
    fc.assert(
      fc.property(part, (p) => {
        expect(sha256(p).equals(createHash('sha256').update(bytesOf(p)).digest())).toBe(true);
      }),
      runs,
    );
  });
});
