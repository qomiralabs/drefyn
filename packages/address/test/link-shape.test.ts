import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isLinkShaped, isPlainAddress, normalizeEmailAddress } from '../src/index.ts';

const ZWJ = '\u200d';

describe('isLinkShaped', () => {
  it.each([
    'http://evil.example',
    'x://y',
    'Acme Security http://evil.example/login',
    'HTTP://EVIL',
    'http\uff1a//evil',
    'www.evil.example',
    'WWW.evil',
    'see www.x',
    'evil.example',
    'Visit evil.example today',
    'evil.co.uk',
    'evil\uff0eexample',
    'evil\u3002example',
    'evil\uff61example',
    '\uff45\uff56\uff49\uff4c.example',
    'x\u0301.com',
    'x.c\u0334om',
    'evil\u0130.com',
    'mail.xn--p1ai',
    'Node.js',
    `evil.${ZWJ}example`,
    `evil.e${ZWJ}xample`,
    `www${ZWJ}.evil.example`,
    `ht${ZWJ}tp://x`,
    'evil.\u200bexample',
    'evil\u00ad.example',
    'evil.\ufeffexample',
    'evil.\u2060example',
    'evil.\u2065example',
    'evil.e\u{e0080}xample',
    'evil.\u3164example',
    '8.8.8.8',
    '8.8.8.8.',
    '8.8.8.8/login',
    '8.8.8.8:8080',
    'see 8.8.8.8 today',
    '(8.8.8.8)',
    'v8.8.8.8',
    '0177.0.0.1',
    '\uff18\uff0e\uff18\uff0e\uff18\uff0e\uff18',
    '8\u30028\u30028\u30028',
    '\u{1d7d6}.\u{1d7d6}.\u{1d7d6}.\u{1d7d6}',
    '\u2467.\u2467.\u2467.\u2467',
    '\u248f\u248f\u248f8',
    '\u0668.\u0668.\u0668.\u0668',
    '8.\u200d8.8.8',
    '8\u0301.8.8.8',
  ])('reads %j as a link', (text) => {
    expect(isLinkShaped(text)).toBe(true);
  });

  it.each([
    '',
    'Acme',
    'Acme Inc.',
    'A. Smith & Sons',
    'Version 2.0',
    'R&D',
    "O'Brien Ltd",
    '\u00dcn\u00efc\u00f8d\u00e9 GmbH',
    'Chrome on macOS',
    'e.g',
    '1.5 million',
    'Version 1.2.3',
    '8.8 8.8',
    `\u{1f468}${ZWJ}\u{1f469}${ZWJ}\u{1f467}`,
  ])('reads %j as plain text', (text) => {
    expect(isLinkShaped(text)).toBe(false);
  });

  // A slow regular expression here would let one long name hold up a mail send.
  it.each([
    ['dots', '.'.repeat(100_000)],
    ['letters', 'a'.repeat(100_000)],
    ['dotted single letters', 'a.'.repeat(50_000)],
    ['joiners', ZWJ.repeat(100_000)],
    ['digits', '1'.repeat(100_000)],
    ['three part numbers', '1.1.1 '.repeat(16_000)],
    ['marks', 'a\u0301'.repeat(50_000)],
  ])('stays linear on 100,000 characters of %s', (_label, text) => {
    const started = performance.now();
    expect(typeof isLinkShaped(text)).toBe('boolean');
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('isPlainAddress', () => {
  it.each([
    'nia@example.com',
    'first.last@example.com',
    "o'neil@example.com",
    'a+tag@example.com',
    'a_b-c@example.com',
    'evil.example@attacker.example',
    'wwwx@example.com',
  ])('accepts %j', (value) => {
    expect(isPlainAddress(value)).toBe(true);
  });

  it.each([
    'www.evil.example/login?a=@attacker.example',
    'a_www.evil.example@attacker.example',
    'www.x@attacker.example',
    'evil.example/x@attacker.example',
    'a%2f@attacker.example',
    'evil.example#@attacker.example',
    'a=b&c@attacker.example',
    'WWW.x@attacker.example',
    'Nia@example.com',
    'nia@Example.com',
    ' nia@example.com',
    'nia',
    'nia@localhost',
    '',
  ])('refuses %j', (value) => {
    expect(isPlainAddress(value)).toBe(false);
  });

  it('holds only for addresses that are already normalised', () => {
    fc.assert(
      fc.property(fc.emailAddress(), (input) => {
        const result = normalizeEmailAddress(input);
        if (result.ok && isPlainAddress(result.value)) {
          expect(result.value.slice(0, result.value.indexOf('@'))).toMatch(/^[a-z0-9._+'-]+$/);
        }
        expect(isPlainAddress(input)).toBe(
          result.ok && result.value === input && isPlainAddress(result.value),
        );
      }),
    );
  });
});
