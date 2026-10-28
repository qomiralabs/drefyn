import { normalizeEmailAddress } from '@drefyn/address';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { normalizeAddress } from '../src/index.ts';
import { anyUnit, runs } from './support.ts';

const ATOM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&'*+-/=?^_`{|}~";
const atom = fc.string({ unit: fc.constantFrom(...Array.from(ATOM)), minLength: 1, maxLength: 12 });
const local = fc.array(atom, { minLength: 1, maxLength: 4 }).map((a) => a.join('.'));
const label = fc
  .stringMatching(/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,10}[a-zA-Z0-9])?$/)
  .filter((l) => !l.includes('--'));
const tld = fc.stringMatching(/^[a-zA-Z]{2,8}$/);
const domain = fc
  .tuple(fc.array(label, { minLength: 1, maxLength: 3 }), tld)
  .map(([labels, t]) => [...labels, t].join('.'));
const address = fc.tuple(local, domain).map(([l, d]) => `${l}@${d}`);

const anything: fc.Arbitrary<string> = fc.oneof(
  address,
  fc.string({ maxLength: 60 }),
  fc
    .array(fc.oneof(anyUnit, fc.constantFrom('@', '.', '"', '(', ')', ' ', 'a', 'Z', '\u00fc')), {
      maxLength: 30,
    })
    .map((p) => p.join('')),
);

describe('normalizeAddress', () => {
  it('is idempotent on everything it accepts', () => {
    fc.assert(
      fc.property(anything, (input) => {
        const once = normalizeAddress(input);
        if (once !== null) expect(normalizeAddress(once)).toBe(once);
      }),
      { ...runs, numRuns: 2000 },
    );
  });

  it('accepts dot atom addresses and lower cases both halves, with no dot or plus folding', () => {
    fc.assert(
      fc.property(address, (input) => {
        expect(normalizeAddress(input)).toBe(input.toLowerCase());
      }),
      runs,
    );
    expect(normalizeAddress('  Jane.Doe+Docs@Example.COM ')).toBe('jane.doe+docs@example.com');
  });

  it('converts a Unicode domain to its ASCII form', () => {
    expect(normalizeAddress('max@B\u00fccher.example')).toBe('max@xn--bcher-kva.example');
    expect(normalizeAddress('max@xn--bcher-kva.example')).toBe('max@xn--bcher-kva.example');
  });

  it('refuses quoted local parts, comments, spaces and a second @', () => {
    for (const input of [
      '"jane"@example.com',
      '"jane doe"@example.com',
      'jane(comment)@example.com',
      '(comment)jane@example.com',
      'jane@(comment)example.com',
      'jane@example.com(comment)',
      'jane doe@example.com',
      'jane@exa mple.com',
      'jane\t@example.com',
      'jane@evil.test@example.com',
      'jane@@example.com',
      '@example.com',
      'jane@',
      'jane',
      'ja\\ne@example.com',
      'jane<x>@example.com',
      'jane,doe@example.com',
      'jane;@example.com',
      'jane:@example.com',
      '[jane]@example.com',
      '.jane@example.com',
      'jane.@example.com',
      'ja..ne@example.com',
      'j\u00e4ne@example.com',
      'jane\u0000@example.com',
      'jane@[192.0.2.1]',
      'jane@192.0.2.1',
      'jane@localhost',
      'jane@-example.com',
      'jane@example-.com',
      'jane@exa..mple.com',
      'jane@example.com.',
      'jane@exa_mple.com',
    ]) {
      expect(normalizeAddress(input)).toBeNull();
    }
  });

  it('refuses CR or LF anywhere, trailing included', () => {
    fc.assert(
      fc.property(address, fc.nat(), fc.constantFrom('\r', '\n', '\r\n'), (input, at, nl) => {
        const i = at % (input.length + 1);
        expect(normalizeAddress(input.slice(0, i) + nl + input.slice(i))).toBeNull();
      }),
      runs,
    );
  });

  it('refuses anything over 254 characters, and a local part over 64', () => {
    const at254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    expect(at254).toHaveLength(254);
    expect(normalizeAddress(at254)).toBe(at254);
    expect(normalizeAddress(`a${at254}`)).toBeNull();
    expect(normalizeAddress(`${'a'.repeat(65)}@example.com`)).toBeNull();
    expect(normalizeAddress(`jane@${'b'.repeat(64)}.com`)).toBeNull();
    fc.assert(
      fc.property(fc.string({ minLength: 255, maxLength: 400 }), (input) => {
        expect(normalizeAddress(input)).toBeNull();
      }),
      { ...runs, numRuns: 50 },
    );
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 1, {}, ['a@b.co']]) {
      expect(normalizeAddress(value)).toBeNull();
    }
  });

  // One rule for auth and email: a second copy here would drift.
  it('agrees with @drefyn/address on every string', () => {
    fc.assert(
      fc.property(anything, (input) => {
        const shared = normalizeEmailAddress(input);
        expect(normalizeAddress(input)).toBe(shared.ok ? shared.value : null);
      }),
      { ...runs, numRuns: 2000 },
    );
  });
});
