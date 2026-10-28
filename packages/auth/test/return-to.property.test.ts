import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { safeReturnTo } from '../src/index.ts';
import { anyUnit, runs } from './support.ts';

const ORIGINS = ['https://app.drefyn.test', 'http://localhost:3000', 'https://[::1]:8443'];

// Pieces that open redirects are made of: scheme and authority markers, both slashes,
// encodings of them, dot segments, whitespace and controls browsers strip, and look alikes.
const PIECES = [
  '/',
  '//',
  '\\',
  '/\\',
  '\\/',
  'evil.test',
  '@',
  ':',
  'https:',
  'javascript:',
  'data:',
  '%2f',
  '%2F',
  '%5c',
  '%09',
  '%00',
  '.',
  '..',
  './',
  '../',
  '?',
  '#',
  '\t',
  '\n',
  '\r',
  '\u0000',
  '\u001f',
  '\u007f',
  '\u0085',
  ' ',
  '\u00a0',
  '\u2028',
  '\u3002',
  '\uff0f',
  '\uff3c',
  'app.drefyn.test',
  'localhost:3000',
  '[::1]',
  'docs',
  'a=b&c=d',
];

const hostile: fc.Arbitrary<string> = fc.oneof(
  fc.array(fc.constantFrom(...PIECES), { maxLength: 12 }).map((p) => p.join('')),
  fc.array(fc.oneof(fc.constantFrom(...PIECES), anyUnit), { maxLength: 16 }).map((p) => p.join('')),
  fc.string({ maxLength: 40 }),
  fc.webUrl({ withQueryParameters: true, withFragments: true }),
);

function assertSafe(result: string, origin: string) {
  expect(result.startsWith('/')).toBe(true);
  expect(result.startsWith('//')).toBe(false);
  expect(result).not.toContain('\\');
  expect(result).not.toMatch(/\p{Cc}/u);
  expect(new URL(result, origin).origin).toBe(origin);
  // A path only reference: resolved anywhere, it stays on that host.
  expect(new URL(result, 'https://elsewhere.test').origin).toBe('https://elsewhere.test');
}

describe('safeReturnTo', () => {
  it('never resolves outside the app origin for any input', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ORIGINS), hostile, (origin, input) => {
        assertSafe(safeReturnTo(input, origin), origin);
      }),
      { ...runs, numRuns: 3000 },
    );
  });

  it('keeps a plain same origin path, query and fragment', () => {
    const origin = 'https://app.drefyn.test';
    expect(safeReturnTo('/acme/docs', origin)).toBe('/acme/docs');
    expect(safeReturnTo('/acme/docs?tab=2#top', origin)).toBe('/acme/docs?tab=2#top');
    expect(safeReturnTo('/', origin)).toBe('/');
    expect(safeReturnTo('/%2F%2Fevil.test', origin)).toBe('/%2F%2Fevil.test');
  });

  it('turns every refused form into /', () => {
    const origin = 'https://app.drefyn.test';
    for (const input of [
      undefined,
      null,
      42,
      '',
      'acme/docs',
      '//evil.test',
      '///evil.test',
      '/\\evil.test',
      '\\\\evil.test',
      '/.//evil.test',
      '/a/..//evil.test',
      'https://evil.test/',
      'https://app.drefyn.test/acme',
      'javascript:alert(1)',
      '/\t/evil.test',
      '/acme\n',
      '/\u0000',
      `/${'a'.repeat(2048)}`,
    ]) {
      expect(safeReturnTo(input, origin)).toBe('/');
    }
  });

  it('is stable: a returned value returns itself', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ORIGINS), hostile, (origin, input) => {
        const once = safeReturnTo(input, origin);
        expect(safeReturnTo(once, origin)).toBe(once);
      }),
      runs,
    );
  });
});
