import fc from 'fast-check';
import { domainToASCII } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isNormalizedEmailAddress, normalizeEmailAddress } from '../src/index.ts';
import { addressLike, anyUnit, asciiAddress, localPart, runs, unicodeDomain } from './support.ts';

const many = { ...runs, numRuns: 2000 } as const;

describe('normalizeEmailAddress properties', () => {
  it('is idempotent, and every output passes the guard', () => {
    fc.assert(
      fc.property(addressLike, (input) => {
        const once = normalizeEmailAddress(input);
        if (!once.ok) return;
        expect(normalizeEmailAddress(once.value)).toEqual(once);
        expect(isNormalizedEmailAddress(once.value)).toBe(true);
      }),
      many,
    );
  });

  it('never throws, and refuses with one of the five reasons', () => {
    fc.assert(
      fc.property(fc.string({ unit: anyUnit, maxLength: 300 }), (input) => {
        const result = normalizeEmailAddress(input);
        if (!result.ok) {
          expect(result.error.code).toBe('address.invalid');
          expect(['length', 'local_part', 'domain', 'control', 'shape']).toContain(
            result.error.reason,
          );
        }
      }),
      many,
    );
  });

  it('accepts dot atom addresses and only lower cases them', () => {
    fc.assert(
      fc.property(asciiAddress, (input) => {
        expect(normalizeEmailAddress(input)).toEqual({ ok: true, value: input.toLowerCase() });
      }),
      runs,
    );
  });

  it('refuses CR or LF anywhere, leading and trailing included', () => {
    fc.assert(
      fc.property(asciiAddress, fc.nat(), fc.constantFrom('\r', '\n', '\r\n'), (input, at, nl) => {
        const i = at % (input.length + 1);
        expect(normalizeEmailAddress(input.slice(0, i) + nl + input.slice(i))).toEqual({
          ok: false,
          error: { code: 'address.invalid', reason: 'control' },
        });
      }),
      runs,
    );
  });

  it('converts the domain exactly as node:url domainToASCII does', () => {
    fc.assert(
      fc.property(localPart, unicodeDomain, (local, domain) => {
        const result = normalizeEmailAddress(`${local}@${domain}`);
        const expected = domainToASCII(domain.toLowerCase());
        if (result.ok) {
          expect(result.value).toBe(`${local.toLowerCase()}@${expected}`);
        } else {
          // The only refusals left for a well formed local part are the domain rules.
          expect(result.error.reason).toMatch(/^(domain|length)$/);
        }
      }),
      many,
    );
  });
});

// Every default ignorable code point except the two joiners, which IDNA keeps and encodes.
const DROPPED_IGNORABLES: readonly string[] = (() => {
  const found: string[] = [];
  for (let code = 0; code <= 0x10ffff; code += 1) {
    const unit = String.fromCodePoint(code);
    if (/\p{Default_Ignorable_Code_Point}/u.test(unit) && !/[\u200c\u200d]/.test(unit)) {
      found.push(unit);
    }
  }
  return found;
})();

describe('default ignorable code points', () => {
  it('refuses every one but the joiners anywhere inside the domain', () => {
    expect(DROPPED_IGNORABLES.length).toBeGreaterThan(100);
    fc.assert(
      fc.property(
        localPart,
        unicodeDomain,
        fc.constantFrom(...DROPPED_IGNORABLES),
        fc.nat(),
        (local, domain, ignorable, at) => {
          const i = 1 + (at % (domain.length - 1));
          const input = `${local}@${domain.slice(0, i)}${ignorable}${domain.slice(i)}`;
          expect(normalizeEmailAddress(input)).toEqual({
            ok: false,
            error: { code: 'address.invalid', reason: 'domain' },
          });
        },
      ),
      many,
    );
  });
});

describe('isNormalizedEmailAddress properties', () => {
  it('is true exactly when the value is its own normalisation', () => {
    fc.assert(
      fc.property(addressLike, (value) => {
        const result = normalizeEmailAddress(value);
        expect(isNormalizedEmailAddress(value)).toBe(result.ok && result.value === value);
      }),
      many,
    );
  });

  it('is false for mixed case, padded and Unicode domain forms of a valid address', () => {
    const variant = fc
      .tuple(localPart, unicodeDomain, fc.constantFrom('upper', 'pad', 'raw'))
      .map(([local, domain, how]) => {
        const raw = `${local}@${domain}`;
        if (how === 'upper') return raw.toUpperCase();
        if (how === 'pad') return ` ${raw}`;
        return raw;
      });
    fc.assert(
      fc.property(variant, (value) => {
        const result = normalizeEmailAddress(value);
        if (result.ok && result.value !== value) {
          expect(isNormalizedEmailAddress(value)).toBe(false);
        }
      }),
      many,
    );
    // The generator must actually reach the case it is about.
    expect(isNormalizedEmailAddress(' a@example.com')).toBe(false);
  });
});
