import fc from 'fast-check';

// FC_SEED replays every property under another seed without editing a file. Unset, every
// machine runs the same seed, so a failure reproduces anywhere.
function seedFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const seed = Number(raw);
  if (!/^-?[0-9]+$/.test(raw) || seed !== (seed | 0)) {
    throw new Error('FC_SEED must be a 32 bit integer');
  }
  return seed;
}

// Raise numRuns locally to hunt.
export const runs = { seed: seedFrom(process.env['FC_SEED'], 150), numRuns: 300 } as const;

// One UTF-16 code unit, lone surrogates included.
export const anyUnit: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 0xffff })
  .map((code) => String.fromCharCode(code));

const ATOM_UNITS = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+-/=?^_`{|}~",
);
const atom = fc.string({ unit: fc.constantFrom(...ATOM_UNITS), minLength: 1, maxLength: 12 });
export const localPart: fc.Arbitrary<string> = fc
  .array(atom, { minLength: 1, maxLength: 4 })
  .map((atoms) => atoms.join('.'));

const asciiLabel = fc
  .stringMatching(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,10}[a-zA-Z0-9])?$/)
  .filter((label) => !label.includes('--'));
// Letters that IDNA maps or encodes, so the Unicode path is exercised, not just ASCII.
const unicodeLabel = fc
  .array(fc.constantFrom('a', 'b', 'z', '\u00fc', '\u00e9', '\u00df', '\u0436', '\u4e2d', 'K'), {
    minLength: 1,
    maxLength: 8,
  })
  .map((units) => units.join(''));
const tld = fc.stringMatching(/^[a-zA-Z]{2,8}$/);

export const asciiDomain: fc.Arbitrary<string> = fc
  .tuple(fc.array(asciiLabel, { minLength: 1, maxLength: 3 }), tld)
  .map(([labels, last]) => [...labels, last].join('.'));
export const unicodeDomain: fc.Arbitrary<string> = fc
  .tuple(fc.array(fc.oneof(asciiLabel, unicodeLabel), { minLength: 1, maxLength: 3 }), tld)
  .map(([labels, last]) => [...labels, last].join('.'));

// Dot atom local part at an ASCII domain, in any case.
export const asciiAddress: fc.Arbitrary<string> = fc
  .tuple(localPart, asciiDomain)
  .map(([local, domain]) => `${local}@${domain}`);

const padding = fc
  .array(fc.constantFrom(' ', '\t', '\u00a0', '\u2028', '\ufeff'), { maxLength: 3 })
  .map((units) => units.join(''));

// Mostly near misses of real addresses: padded, mixed case, Unicode domains, and stray
// control, quote, comment and separator characters, plus some plain noise.
export const addressLike: fc.Arbitrary<string> = fc.oneof(
  asciiAddress,
  fc
    .tuple(padding, localPart, unicodeDomain, padding)
    .map(([before, local, domain, after]) => `${before}${local}@${domain}${after}`),
  fc
    .tuple(asciiAddress, fc.nat(), fc.oneof(anyUnit, fc.constantFrom('\0', '\r', '\n', '\t')))
    .map(([address, at, unit]) => {
      const i = at % (address.length + 1);
      return address.slice(0, i) + unit + address.slice(i);
    }),
  fc
    .array(
      fc.oneof(
        anyUnit,
        fc.constantFrom('@', '.', '"', '(', ')', ' ', '/', '%', '#', '?', 'a', 'Z', '\u00fc'),
      ),
      { maxLength: 30 },
    )
    .map((units) => units.join('')),
  fc.string({ maxLength: 60 }),
);
