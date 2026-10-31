import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RESERVED_SLUGS, SLUG_PATTERN, parseOrganizationName, parseSlug } from '../src/index.ts';
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
    for (const route of ['sign-in', 'sign-out', 'auth', 'invite', 'api', 'settings', 'new']) {
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

const domainLike = fc.tuple(word, dot, letters, fc.boolean()).map(([label, d, tld, wide]) => {
  const text = `${label}${d}${tld}`;
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
