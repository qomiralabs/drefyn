import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { smallHasher } from './password-fixtures.ts';
import { runs } from './support.ts';

// Each run hashes, so fewer runs than the cheap properties; the hash is tiny either way.
const HASH_RUNS = { ...runs, numRuns: 120 } as const;

// Text that keeps its bytes stable: whole code points, no lone surrogates.
const text = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 12 });

// Inside the 1,024 byte cap after NFKC, which a few expanding characters can pass.
const fits = (s: string) => Buffer.byteLength(s.normalize('NFKC')) <= 1024;

// Characters with a compatibility or canonical twin, so the forms really differ.
const twins = fc.constantFrom(
  '\u00e9', // e acute, composed
  'e\u0301', // e and a combining acute
  '\uff41', // fullwidth a
  '\u2460', // circled 1
  '\u00bd', // one half
  '\ufb01', // fi ligature
  '\u2126', // ohm sign
  '\u212b', // angstrom sign
  '\u1e9b\u0323', // long s with dots
);

const forms = ['NFC', 'NFD', 'NFKC', 'NFKD'] as const;

describe('NFKC equivalence', () => {
  it('a password verifies when typed in any normalisation form of itself', async () => {
    const hasher = smallHasher();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(text, twins), { minLength: 1, maxLength: 6 }),
        fc.constantFrom(...forms),
        fc.constantFrom(...forms),
        async (parts, stored, typed) => {
          const password = parts.join('');
          fc.pre(fits(password));
          const phc = await hasher.hash(password.normalize(stored));
          expect(await hasher.verify(phc, password.normalize(typed))).toBe(true);
        },
      ),
      HASH_RUNS,
    );
  });

  it('passwords with different NFKC forms never verify against each other', async () => {
    const hasher = smallHasher();
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(text, twins), { minLength: 1, maxLength: 6 }),
        fc.array(fc.oneof(text, twins), { minLength: 1, maxLength: 6 }),
        async (a, b) => {
          const first = a.join('');
          const second = b.join('');
          fc.pre(fits(first) && fits(second));
          fc.pre(first.normalize('NFKC') !== second.normalize('NFKC'));
          const phc = await hasher.hash(first);
          expect(await hasher.verify(phc, second)).toBe(false);
        },
      ),
      HASH_RUNS,
    );
  });

  it('one changed character never verifies', async () => {
    const hasher = smallHasher();
    await fc.assert(
      fc.asyncProperty(
        fc.string({ unit: 'grapheme-ascii', minLength: 15, maxLength: 40 }),
        fc.nat(),
        async (password, at) => {
          const i = at % password.length;
          const changed =
            password.slice(0, i) +
            String.fromCharCode(((password.charCodeAt(i) - 31) % 95) + 32) +
            password.slice(i + 1);
          fc.pre(changed !== password);
          const phc = await hasher.hash(password);
          expect(await hasher.verify(phc, changed)).toBe(false);
        },
      ),
      HASH_RUNS,
    );
  });
});
