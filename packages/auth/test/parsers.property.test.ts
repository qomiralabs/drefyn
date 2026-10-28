import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { idOf, organizationId, toPublicId } from '@drefyn/tenancy';
import {
  decodeSecret,
  encodeSecret,
  formatApiKey,
  formatInvitationToken,
  formatSessionToken,
  formatVerifyFragment,
  parseApiKey,
  parseBearer,
  parseCode,
  parseInvitationToken,
  parseSessionToken,
  parseVerifyFragment,
} from '../src/index.ts';
import {
  CROCKFORD,
  UUID_A,
  UUID_B,
  anyUuid,
  lengthChangesOf,
  mutationsOf,
  runs,
  secretBytes,
} from './support.ts';

const body = (uuid: string) => toPublicId('usr', idOf('usr', uuid)).slice(4);

interface Format<T> {
  readonly name: string;
  readonly valid: fc.Arbitrary<string>;
  readonly parse: (value: unknown) => T | null;
  readonly format: (parsed: T) => string;
  readonly length: number;
}

// One shape for every format: the canonical text of what the parser accepted, or null.
interface Case {
  readonly name: string;
  readonly valid: fc.Arbitrary<string>;
  readonly length: number;
  readonly canonical: (value: unknown) => string | null;
}

function erase<T>(f: Format<T>): Case {
  return {
    name: f.name,
    valid: f.valid,
    length: f.length,
    canonical: (value) => {
      const parsed = f.parse(value);
      return parsed === null ? null : f.format(parsed);
    },
  };
}

const formats: readonly Case[] = [
  erase<NonNullable<ReturnType<typeof parseSessionToken>>>({
    name: 'session token',
    valid: fc
      .tuple(anyUuid, anyUuid, secretBytes)
      .map(([u, s, b]) => formatSessionToken({ userId: idOf('usr', u), sessionId: s, secret: b })),
    parse: parseSessionToken,
    format: formatSessionToken,
    length: 109,
  }),
  erase<NonNullable<ReturnType<typeof parseApiKey>>>({
    name: 'API key',
    valid: fc
      .tuple(anyUuid, anyUuid, secretBytes)
      .map(([o, k, b]) =>
        formatApiKey({ organizationId: organizationId(o), keyId: idOf('key', k), secret: b }),
      ),
    parse: parseApiKey,
    format: formatApiKey,
    length: 113,
  }),
  erase<NonNullable<ReturnType<typeof parseInvitationToken>>>({
    name: 'invitation token',
    valid: fc
      .tuple(anyUuid, anyUuid, secretBytes)
      .map(([o, i, b]) =>
        formatInvitationToken({ organizationId: organizationId(o), invitationId: i, secret: b }),
      ),
    parse: parseInvitationToken,
    format: formatInvitationToken,
    length: 106,
  }),
  erase<string>({
    name: 'email code',
    valid: fc.stringMatching(/^[0-9]{8}$/),
    parse: parseCode,
    format: (code: string) => code,
    length: 8,
  }),
  erase<NonNullable<ReturnType<typeof parseVerifyFragment>>>({
    name: 'verify link fragment',
    valid: fc
      .tuple(anyUuid, fc.stringMatching(/^[0-9]{8}$/))
      .map(([c, code]) => formatVerifyFragment({ challengeId: c, code })),
    parse: parseVerifyFragment,
    format: formatVerifyFragment,
    length: 35,
  }),
  erase<Buffer>({
    name: 'pre sign in and OAuth state cookie',
    valid: secretBytes.map(encodeSecret),
    parse: decodeSecret,
    format: encodeSecret,
    length: 52,
  }),
];

describe.each(formats)('$name', (f) => {
  it('round trips and has the documented length', () => {
    fc.assert(
      fc.property(f.valid, (valid) => {
        expect(valid).toHaveLength(f.length);
        expect(f.canonical(valid)).toBe(valid);
      }),
      runs,
    );
  });

  // A replacement inside the alphabet can name another well formed credential, which then
  // fails its hash compare. What the parser guarantees is that nothing else gets through:
  // whatever it accepts is the one canonical encoding of a different value.
  it('refuses every single character edit unless it is the canonical form of another value', () => {
    fc.assert(
      fc.property(
        f.valid.chain((valid) => fc.tuple(fc.constant(valid), mutationsOf(valid))),
        ([valid, mutation]) => {
          const canonical = f.canonical(mutation.value);
          if (mutation.kind !== 'replace') {
            expect(canonical).toBeNull();
            return;
          }
          if (canonical !== null) {
            expect(canonical).toBe(mutation.value);
            expect(mutation.value).not.toBe(valid);
          }
        },
      ),
      { ...runs, numRuns: 1000 },
    );
  });

  it('refuses a replacement outside the symbols of the format', () => {
    const outside = fc
      .integer({ min: 0, max: 0xffff })
      .map((code) => String.fromCharCode(code))
      .filter((c) => !`${CROCKFORD}._`.includes(c));
    fc.assert(
      fc.property(f.valid, fc.nat(), outside, (valid, at, c) => {
        const i = at % valid.length;
        expect(f.canonical(valid.slice(0, i) + c + valid.slice(i + 1))).toBeNull();
      }),
      runs,
    );
  });

  it('refuses every length change', () => {
    fc.assert(
      fc.property(
        f.valid.chain((valid) => lengthChangesOf(valid)),
        (changed) => {
          expect(f.canonical(changed)).toBeNull();
        },
      ),
      runs,
    );
  });

  it('refuses upper case, surrounding space and anything that is not a string', () => {
    fc.assert(
      fc.property(f.valid, (valid) => {
        if (/[a-z]/.test(valid)) expect(f.canonical(valid.toUpperCase())).toBeNull();
        expect(f.canonical(` ${valid}`)).toBeNull();
        expect(f.canonical(`${valid}\n`)).toBeNull();
      }),
      runs,
    );
    for (const value of [undefined, null, 12345678, {}, [], Symbol('x'), 'x'.repeat(100_000)]) {
      expect(f.canonical(value)).toBeNull();
    }
  });
});

describe('id bodies inside tokens', () => {
  it('refuses a first symbol above 7, which would need a 129th bit', () => {
    fc.assert(
      fc.property(
        anyUuid,
        anyUuid,
        secretBytes,
        fc.constantFrom(...Array.from(CROCKFORD.slice(8))),
        (u, s, b, c) => {
          const token = formatSessionToken({ userId: idOf('usr', u), sessionId: s, secret: b });
          expect(parseSessionToken(`v1.${c}${token.slice(4)}`)).toBeNull();
          expect(parseSessionToken(`${token.slice(0, 30)}${c}${token.slice(31)}`)).toBeNull();
        },
      ),
      runs,
    );
  });

  it('decodes the ids the tenancy codec wrote', () => {
    fc.assert(
      fc.property(anyUuid, anyUuid, secretBytes, (o, k, b) => {
        const key = formatApiKey({
          organizationId: organizationId(o),
          keyId: idOf('key', k),
          secret: b,
        });
        expect(key).toBe(`drf_ak_${body(o)}_${body(k)}_${encodeSecret(b)}`);
        expect(parseApiKey(key)).toEqual({
          organizationId: o,
          keyId: k,
          secret: Buffer.from(b),
        });
      }),
      runs,
    );
  });
});

describe('secrets', () => {
  it('encodes 32 bytes as 52 lowercase symbols with four zero bits in front', () => {
    expect(encodeSecret(new Uint8Array(32))).toBe('0'.repeat(52));
    expect(encodeSecret(new Uint8Array(32).fill(255))).toBe(`1${'z'.repeat(51)}`);
    expect(decodeSecret(`2${'0'.repeat(51)}`)).toBeNull();
  });

  it('refuses to encode anything but 32 bytes', () => {
    expect(() => encodeSecret(new Uint8Array(31))).toThrow(RangeError);
  });
});

describe('parseBearer', () => {
  const key = formatApiKey({
    organizationId: organizationId(UUID_A),
    keyId: idOf('key', UUID_B),
    secret: new Uint8Array(32).fill(1),
  });

  it('reads exactly "Bearer <key>"', () => {
    expect(parseBearer(`Bearer ${key}`)).toEqual(parseApiKey(key));
  });

  it('refuses other schemes, spacing, a missing header and anything over 512 bytes', () => {
    for (const header of [
      undefined,
      '',
      key,
      `bearer ${key}`,
      `Bearer  ${key}`,
      `Bearer ${key} `,
      `Basic ${key}`,
      `Bearer\t${key}`,
      `Bearer ${key},Bearer ${key}`,
      `Bearer ${key}${'x'.repeat(500)}`,
    ]) {
      expect(parseBearer(header)).toBeNull();
    }
  });
});
