import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { idOf, parsePublicId, toPublicId, type IdKind } from '../src/index.ts';
import {
  CROCKFORD,
  FIRST_BINARY_PROPERTY_TIMEOUT_MS,
  PREFIXES,
  anyUuid,
  codeOf,
  oracleBody,
  runs,
} from './support.ts';

// The literal list, not ID_KINDS, so this file fails per test rather than at load.
const kind: fc.Arbitrary<IdKind> = fc.constantFrom(...PREFIXES);

const twoKinds: fc.Arbitrary<[IdKind, IdKind]> = fc.tuple(kind, kind).filter(([a, b]) => a !== b);

function publicPattern(prefix: string): RegExp {
  return new RegExp(`^${prefix}_[0-9a-hjkmnp-tv-z]{26}$`);
}

// Symbols that look plausible but are outside the lowercase alphabet.
const outside = fc.constantFrom(
  ...Array.from('ILOUilouABCXYZ-_ !./:+=\u0000\n\u00e9\uff10\u0430'),
  '\ud800',
  '\u{1f600}',
);

const mutated = fc.oneof(
  // One symbol replaced by one outside the alphabet.
  fc.tuple(kind, anyUuid, fc.nat({ max: 25 }), outside).map(([k, u, i, c]) => {
    const body = oracleBody(u);
    return [k, `${k}_${body.slice(0, i)}${c}${body.slice(i + 1)}`] as const;
  }),
  // Wrong length.
  fc
    .tuple(
      kind,
      anyUuid,
      fc.integer({ min: 0, max: 60 }).filter((n) => n !== 26),
    )
    .map(([k, u, n]) => {
      const body = oracleBody(u).repeat(3).slice(0, n);
      return [k, `${k}_${body}`] as const;
    }),
  // First symbol above 7: the value would need more than 128 bits.
  fc
    .tuple(kind, anyUuid, fc.constantFrom(...Array.from(CROCKFORD.slice(8))))
    .map(([k, u, c]) => [k, `${k}_${c}${oracleBody(u).slice(1)}`] as const),
  // Whole string uppercased.
  fc.tuple(kind, anyUuid).map(([k, u]) => [k, `${k}_${oracleBody(u)}`.toUpperCase()] as const),
);

// Mostly valid shapes with symbols from a mixed alphabet, so some parse and some do not.
const nearValid = fc
  .tuple(
    kind,
    kind,
    fc.string({
      unit: fc.constantFrom(...Array.from(`${CROCKFORD}ILOUilouZ`)),
      minLength: 25,
      maxLength: 27,
    }),
  )
  .map(([expected, prefix, body]) => [expected, `${prefix}_${body}`] as const);

// Valid bodies built from the alphabet itself, first symbol 0 to 7, with the expected kind
// matching the prefix half the time, so the parse and the wrong type branches both run.
const wellFormed = fc
  .tuple(
    fc.oneof(
      kind.map((k) => [k, k] as const),
      fc.tuple(kind, kind),
    ),
    fc.constantFrom(...Array.from(CROCKFORD.slice(0, 8))),
    fc.string({ unit: fc.constantFrom(...Array.from(CROCKFORD)), minLength: 25, maxLength: 25 }),
  )
  .map(([[expected, prefix], first, rest]) => [expected, `${prefix}_${first}${rest}`] as const);

describe('public ID codec (property)', () => {
  it('round trips every UUID for every kind and matches the public pattern', () => {
    fc.assert(
      fc.property(kind, anyUuid, (k, uuid) => {
        const encoded = toPublicId(k, idOf(k, uuid));
        expect(encoded).toMatch(publicPattern(k));
        expect(parsePublicId(k, encoded)).toBe(uuid);
      }),
      runs,
    );
  });

  it('encodes the same 128 bits as an independent BigInt encoder', () => {
    fc.assert(
      fc.property(kind, anyUuid, (k, uuid) => {
        expect(toPublicId(k, idOf(k, uuid))).toBe(`${k}_${oracleBody(uuid)}`);
      }),
      runs,
    );
  });

  it('keeps UUID order, so time ordered ids stay time ordered in public form', () => {
    fc.assert(
      fc.property(kind, anyUuid, anyUuid, (k, a, b) => {
        const pa = toPublicId(k, idOf(k, a));
        const pb = toPublicId(k, idOf(k, b));
        expect(pa < pb).toBe(a < b);
        expect(pa === pb).toBe(a === b);
      }),
      runs,
    );
  });

  it('rejects a valid id of another kind with ID_WRONG_TYPE', () => {
    fc.assert(
      fc.property(twoKinds, anyUuid, ([a, b], uuid) => {
        expect(codeOf(() => parsePublicId(b, toPublicId(a, idOf(a, uuid))))).toBe('ID_WRONG_TYPE');
      }),
      runs,
    );
  });

  it('rejects bad symbols, bad length, uppercase and more than 128 bits with ID_MALFORMED', () => {
    fc.assert(
      fc.property(mutated, ([k, value]) => {
        expect(codeOf(() => parsePublicId(k, value))).toBe('ID_MALFORMED');
      }),
      runs,
    );
  });

  it(
    'gives each id exactly one public form: whatever parses re-encodes to the same string',
    {
      timeout: FIRST_BINARY_PROPERTY_TIMEOUT_MS,
    },
    () => {
      const seen = new Map<string, number>();
      fc.assert(
        fc.property(
          fc.oneof(
            wellFormed,
            nearValid,
            fc.tuple(kind, fc.string({ unit: 'binary', maxLength: 40 })),
            mutated,
          ),
          ([k, value]) => {
            const code = codeOf(() => parsePublicId(k, value));
            seen.set(code, (seen.get(code) ?? 0) + 1);
            if (code === 'no error') {
              expect(toPublicId(k, parsePublicId(k, value))).toBe(value);
            } else {
              expect(['ID_MALFORMED', 'ID_WRONG_TYPE']).toContain(code);
            }
          },
        ),
        runs,
      );
      // Without these the property could pass by rejecting everything.
      expect(seen.get('no error') ?? 0).toBeGreaterThan(0);
      expect(seen.get('ID_WRONG_TYPE') ?? 0).toBeGreaterThan(0);
      expect(seen.get('ID_MALFORMED') ?? 0).toBeGreaterThan(0);
    },
  );

  it('never throws anything but a TenancyError on arbitrary input', () => {
    fc.assert(
      fc.property(kind, fc.string({ unit: 'binary', maxLength: 200 }), (k, value) => {
        expect(['no error', 'ID_MALFORMED', 'ID_WRONG_TYPE']).toContain(
          codeOf(() => parsePublicId(k, value)),
        );
      }),
      runs,
    );
  });
});
