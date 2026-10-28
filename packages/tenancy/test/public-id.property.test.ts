import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { idOf, parsePublicId, toPublicId, type IdKind } from '../src/index.ts';
import { CROCKFORD, PREFIXES, anyUuid, codeOf, oracleBody, runs } from './support.ts';

// Session tokens and invitation links carry these, so they get their own exhaustive check.
const NEW_KINDS = ['ses', 'inv'] as const;
const newKind = fc.constantFrom(...NEW_KINDS);

// Every ASCII code unit plus a few look alikes, a lone surrogate and an astral character.
const REPLACEMENTS: readonly string[] = [
  ...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
  'é',
  '０',
  'а',
  'ı',
  '\ud800',
  '\u{1f600}',
];

// Written independently of the package: BigInt arithmetic over the 26 symbols.
function oracleUuid(body: string): string {
  let n = 0n;
  for (const symbol of body) n = (n << 5n) | BigInt(CROCKFORD.indexOf(symbol));
  const h = n.toString(16).padStart(32, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Outcome = 'ID_MALFORMED' | 'ID_WRONG_TYPE' | { readonly uuid: string };

// What parsing must do with `kind` after the character at `index` became `next`.
function expectedOutcome(kind: IdKind, mutated: string, index: number, next: string): Outcome {
  if (index < 3) {
    const prefix = mutated.slice(0, 3);
    const known = mutated.length === 30 && (PREFIXES as readonly string[]).includes(prefix);
    return known ? 'ID_WRONG_TYPE' : 'ID_MALFORMED';
  }
  if (index === 3) return 'ID_MALFORMED';
  const value = CROCKFORD.indexOf(next);
  if (next.length !== 1 || value < 0) return 'ID_MALFORMED';
  // A first symbol above 7 would need a 129th bit.
  if (index === 4 && value > 7) return 'ID_MALFORMED';
  return { uuid: oracleUuid(mutated.slice(4)) };
}

describe('public ID codec for session and invitation ids (property)', () => {
  it('round trips every UUID and matches the public pattern', () => {
    fc.assert(
      fc.property(newKind, anyUuid, (kind, uuid) => {
        const encoded = toPublicId(kind, idOf(kind, uuid));
        expect(encoded).toMatch(new RegExp(`^${kind}_[0-9a-hjkmnp-tv-z]{26}$`));
        expect(encoded).toBe(`${kind}_${oracleBody(uuid)}`);
        expect(parsePublicId(kind, encoded)).toBe(uuid);
      }),
      runs,
    );
  });

  it('refuses a valid id of any other kind with ID_WRONG_TYPE, both ways', () => {
    const other = fc.constantFrom(...PREFIXES);
    fc.assert(
      fc.property(newKind, other, anyUuid, (kind, otherKind, uuid) => {
        fc.pre(kind !== otherKind);
        const ours = toPublicId(kind, idOf(kind, uuid));
        const theirs = toPublicId(otherKind, idOf(otherKind, uuid));
        expect(codeOf(() => parsePublicId(otherKind, ours))).toBe('ID_WRONG_TYPE');
        expect(codeOf(() => parsePublicId(kind, theirs))).toBe('ID_WRONG_TYPE');
      }),
      runs,
    );
  });

  // A substitution inside the body that stays in the alphabet is another valid id; there is
  // no checksum. What must never happen is a mutation that parses back to the same id, or a
  // non canonical spelling that parses at all.
  it('never accepts a single character substitution as the original id or a second spelling', () => {
    let accepted = 0;
    let refused = 0;
    fc.assert(
      fc.property(newKind, anyUuid, (kind, uuid) => {
        const original = toPublicId(kind, idOf(kind, uuid));
        for (let index = 0; index < original.length; index += 1) {
          for (const next of REPLACEMENTS) {
            if (next === original.charAt(index)) continue;
            const mutated = `${original.slice(0, index)}${next}${original.slice(index + 1)}`;
            const expected = expectedOutcome(kind, mutated, index, next);
            const code = codeOf(() => parsePublicId(kind, mutated));
            if (typeof expected === 'string') {
              refused += 1;
              expect(code).toBe(expected);
            } else {
              accepted += 1;
              expect(code).toBe('no error');
              const parsed = parsePublicId(kind, mutated);
              expect(parsed).toBe(expected.uuid);
              expect(parsed).not.toBe(uuid);
              expect(toPublicId(kind, parsed)).toBe(mutated);
            }
          }
        }
      }),
      { ...runs, numRuns: 100 },
    );
    // Both branches must run, or the property proves nothing.
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it('refuses every single character deletion and insertion with ID_MALFORMED', () => {
    fc.assert(
      fc.property(
        newKind,
        anyUuid,
        fc.constantFrom(...Array.from(CROCKFORD), '_'),
        (kind, uuid, extra) => {
          const original = toPublicId(kind, idOf(kind, uuid));
          for (let index = 0; index <= original.length; index += 1) {
            const inserted = `${original.slice(0, index)}${extra}${original.slice(index)}`;
            expect(codeOf(() => parsePublicId(kind, inserted))).toBe('ID_MALFORMED');
            if (index < original.length) {
              const deleted = `${original.slice(0, index)}${original.slice(index + 1)}`;
              expect(codeOf(() => parsePublicId(kind, deleted))).toBe('ID_MALFORMED');
            }
          }
        },
      ),
      runs,
    );
  });
});
