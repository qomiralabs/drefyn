import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, SLUG_PATTERN, parseOrganizationName, parseSlug } from '../src/index.ts';
import {
  SLUG_SUFFIX_ALPHABET,
  SLUG_SUFFIX_LENGTH,
  slugCandidate,
} from '../src/organization-rules.ts';
import { runs } from './support.ts';

const codeOf = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? 'ok' : result.error?.code;

const slugChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split(''));
const slugEnd = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''));

// Every slug the pattern allows: an alphanumeric at each end, hyphens only inside.
const shapedSlug = fc.oneof(
  slugEnd,
  fc
    .tuple(slugEnd, fc.array(slugChar, { maxLength: 38 }), slugEnd)
    .map(([a, middle, b]) => `${a}${middle.join('')}${b}`),
);

describe('slugs', () => {
  it('accepts every slug in the pattern that is not reserved', () => {
    fc.assert(
      fc.property(
        shapedSlug.filter((s) => !RESERVED_SLUGS.includes(s)),
        (slug) => {
          const result = parseSlug(slug);
          expect(result).toEqual({ ok: true, value: slug });
        },
      ),
      runs,
    );
  });

  it('refuses anything outside the pattern with AUTH_SLUG_INVALID', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60, unit: 'binary' }).filter((s) => !SLUG_PATTERN.test(s)),
        (value) => {
          expect(codeOf(parseSlug(value))).toBe('AUTH_SLUG_INVALID');
        },
      ),
      runs,
    );
  });

  it.each([
    '',
    'Acme',
    'acme-',
    '-acme',
    'ac_me',
    'acme.com',
    'acme corp',
    ' acme',
    'acme\n',
    'a'.repeat(41),
    'ａｃｍｅ',
  ])('refuses %j', (value) => {
    expect(codeOf(parseSlug(value))).toBe('AUTH_SLUG_INVALID');
  });

  it('accepts the longest slug the pattern allows', () => {
    expect(parseSlug('a'.repeat(40))).toEqual({ ok: true, value: 'a'.repeat(40) });
  });

  it.each([undefined, null, 7, ['acme'], { slug: 'acme' }])(
    'refuses the non string %j',
    (value) => {
      expect(codeOf(parseSlug(value))).toBe('AUTH_SLUG_INVALID');
    },
  );

  it('refuses every reserved word, each of which fits the pattern', () => {
    expect(RESERVED_SLUGS.length).toBeGreaterThan(0);
    for (const word of RESERVED_SLUGS) {
      expect(SLUG_PATTERN.test(word), word).toBe(true);
      expect(codeOf(parseSlug(word)), word).toBe('AUTH_SLUG_INVALID');
    }
  });

  it('reserves the dashboard routes that sit beside /<slug>', () => {
    for (const route of [
      'sign-in',
      'sign-out',
      'auth',
      'auth-states',
      'bundle-baseline',
      'invite',
      'api',
      'settings',
      'new',
      'welcome',
      'organizations',
    ]) {
      expect(RESERVED_SLUGS, route).toContain(route);
    }
  });

  it('keeps the database pattern and the code pattern the same', () => {
    expect(SLUG_PATTERN.source).toBe('^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$');
  });
});

// Plain words: letters from several scripts, digits, spaces and the punctuation names use.
const word = fc
  .array(
    fc.constantFrom(
      ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789éßøЖж北京'.split(''),
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((chars) => chars.join(''));
const safeName = fc
  .array(fc.tuple(word, fc.constantFrom(' ', ' & ', ', ', ' - ', "'s ", '. ')), {
    minLength: 0,
    maxLength: 5,
  })
  .chain((parts) => word.map((last) => parts.map(([w, sep]) => w + sep).join('') + last))
  .filter((name) => name.length <= 100);

// Dots a mail client or a browser may read as a label separator once normalised.
const dot = fc.constantFrom('.', '。', '．', '｡');
const letters = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')), {
    minLength: 2,
    maxLength: 8,
  })
  .map((chars) => chars.join(''));
const fullWidth = (text: string) =>
  Array.from(text, (c) =>
    /[A-Za-z0-9]/.test(c) ? String.fromCodePoint((c.codePointAt(0) ?? 0) + 0xfee0) : c,
  ).join('');

// What may sit right before the dot: combining marks, the dotted capital I (which lowercases
// to i plus a mark), and the punctuation a hostname or a linkifier still accepts.
const labelEnd = fc.constantFrom('', '\u0301', '\u0300', '\u0334', '_', '-', 'İ', '~', '+');
const domainLike = fc
  .tuple(word, labelEnd, dot, letters, fc.boolean())
  .map(([label, end, d, tld, wide]) => {
    const text = `${label}${end}${d}${tld}`;
    return wide ? fullWidth(text) : text;
  });
const scheme = fc
  .tuple(fc.constantFrom('http', 'https', 'ftp', 'x'), fc.constantFrom('://', '：//'), word)
  .map(([s, sep, rest]) => `${s}${sep}${rest}`);
const www = fc
  .tuple(fc.constantFrom('www', 'WWW', 'Www', 'ｗｗｗ'), dot, word)
  .map(([w, d, rest]) => `${w}${d}${rest}`);
const hostile = fc.oneof(domainLike, scheme, www);

describe('organization names', () => {
  it('accepts plain names and returns them trimmed and normalised', () => {
    fc.assert(
      fc.property(safeName, fc.constantFrom('', ' ', '  '), (name, pad) => {
        const result = parseOrganizationName(`${pad}${name}${pad}`);
        expect(result).toEqual({ ok: true, value: name.normalize('NFKC').trim() });
      }),
      runs,
    );
  });

  it('refuses any name carrying a link form, wherever it sits', () => {
    fc.assert(
      fc.property(safeName, hostile, safeName, fc.nat({ max: 2 }), (before, bad, after, at) => {
        const name =
          [`${before} ${bad} ${after}`, `${bad} ${after}`, `${before} ${bad}`][at] ?? bad;
        fc.pre(Array.from(name.normalize('NFKC').trim()).length <= 100);
        expect(codeOf(parseOrganizationName(name)), name).toBe('AUTH_INPUT_INVALID');
      }),
      runs,
    );
  });

  it.each([
    'acme.com',
    'Visit acme.io today',
    'ACME.COM',
    'www.acme',
    'https://acme',
    'acme。com',
    'acme．com',
    'ａｃｍｅ.ｃｏｍ',
    'evil.co.uk',
    'mail.xn--p1ai',
    'x\u0301.com',
    'x_.com',
    'a-.com',
    'x\u0300.org',
    'evilİ.com',
    'x.c\u0334om',
  ])('refuses %j', (name) => {
    expect(codeOf(parseOrganizationName(name))).toBe('AUTH_INPUT_INVALID');
  });

  it.each(['Acme Inc.', 'A. Smith & Sons', 'Version 2.0', 'R&D', "O'Brien Ltd", 'Ünïcødé GmbH'])(
    'accepts %j',
    (name) => {
      expect(parseOrganizationName(name)).toEqual({ ok: true, value: name.normalize('NFKC') });
    },
  );

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['a control character', 'Acme\u0000Inc'],
    ['a line break', 'Acme\nInc'],
    ['a zero width space', 'acme​.com'],
    ['a right to left override', 'Acme‮Inc'],
    ['a line separator', 'Acme Inc'],
    ['a lone surrogate', 'Acme\ud800'],
    ['101 characters', 'a'.repeat(101)],
  ])('refuses %s', (_label, name) => {
    expect(codeOf(parseOrganizationName(name))).toBe('AUTH_INPUT_INVALID');
  });

  it('counts the length in characters, not UTF-16 units', () => {
    expect(parseOrganizationName('😀'.repeat(100)).ok).toBe(true);
  });

  it.each([undefined, null, 1, ['Acme']])('refuses the non string %j', (value) => {
    expect(codeOf(parseOrganizationName(value))).toBe('AUTH_INPUT_INVALID');
  });
});

const suffix = fc
  .array(fc.constantFrom(...SLUG_SUFFIX_ALPHABET.split('')), {
    minLength: SLUG_SUFFIX_LENGTH,
    maxLength: SLUG_SUFFIX_LENGTH,
  })
  .map((chars) => chars.join(''));
const reservedName = fc
  .constantFrom(...RESERVED_SLUGS)
  .chain((word) =>
    fc.constantFrom(word, word.toUpperCase(), word.replaceAll('-', ' '), ` ${word}! `),
  );
const noLatin = fc
  .array(fc.constantFrom(...'北京東京Москваأحمد!? '.split('')), { minLength: 1, maxLength: 20 })
  .map((chars) => `x${chars.join('')}`.slice(1));
const longName = fc.string({ minLength: 39, maxLength: 100, unit: fc.constantFrom('a', ' ', '-') });
const anyName = fc.oneof(safeName, reservedName, noLatin, longName, fc.string({ maxLength: 100 }));

describe('slug candidates', () => {
  it('gives a valid slug for every name on every try', () => {
    fc.assert(
      fc.property(anyName, suffix, fc.nat({ max: 4 }), (name, end, attempt) => {
        expect(parseSlug(slugCandidate(name, end, attempt)).ok).toBe(true);
      }),
      runs,
    );
  });

  it('carries the suffix on every retry, so a retry never asks for the same slug', () => {
    fc.assert(
      fc.property(anyName, suffix, fc.integer({ min: 1, max: 4 }), (name, end, attempt) => {
        expect(slugCandidate(name, end, attempt).endsWith(`-${end}`)).toBe(true);
      }),
      runs,
    );
  });

  it('adds a suffix on the first try to a reserved word or a name with nothing usable', () => {
    fc.assert(
      fc.property(fc.oneof(reservedName, noLatin), suffix, (name, end) => {
        const slug = slugCandidate(name, end, 0);
        expect(slug.endsWith(`-${end}`)).toBe(true);
        expect(RESERVED_SLUGS).not.toContain(slug);
      }),
      runs,
    );
  });

  it.each([
    ['Acme Inc', 'acme-inc'],
    ['Crème Brûlée', 'creme-brulee'],
    ['Ørsted Æther', 'orsted-aether'],
    ['Straße Łódź', 'strasse-lodz'],
  ])('leaves a plain slug alone on the first try: %j', (name, slug) => {
    expect(slugCandidate(name, 'b2c3', 0)).toBe(slug);
  });

  it('never ends the stem on a hyphen when the name is cut to fit', () => {
    const name = `${'a'.repeat(34)}-${'b'.repeat(10)}`;
    expect(slugCandidate(name, 'b2c3', 1)).toBe(`${'a'.repeat(34)}-b2c3`);
  });

  it('falls back to org for a name with no Latin letters', () => {
    expect(slugCandidate('北京', 'b2c3', 0)).toBe('org-b2c3');
  });

  it('has no vowels in the alphabet, so a suffix cannot spell a word', () => {
    expect(SLUG_SUFFIX_ALPHABET).toMatch(/^[b-df-hj-km-np-tv-xz2-9]+$/);
    expect(new Set(SLUG_SUFFIX_ALPHABET).size).toBe(SLUG_SUFFIX_ALPHABET.length);
  });
});
