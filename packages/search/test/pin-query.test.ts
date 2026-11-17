import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseLocaleTag, parseSearchPin, parseVersionKey } from '../src/pin.ts';
import { MAX_QUERY_BYTES, parseSearchQuery } from '../src/query.ts';

const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

describe('parseSearchPin', () => {
  it('reads missing values as the latest line in the default language', () => {
    expect(parseSearchPin({})).toEqual({ version: 'latest', locale: 'default' });
  });

  it('accepts version keys and canonicalises locale case', () => {
    expect(parseSearchPin({ version: 'v1.2', locale: 'en-us' })).toEqual({
      version: 'v1.2',
      locale: 'en-US',
    });
    expect(parseLocaleTag('zh-hant-tw')).toBe('zh-Hant-TW');
  });

  it.each([
    ['V1', 'en'],
    ['-v1', 'en'],
    ['v`1', 'en'],
    ['a'.repeat(33), 'en'],
    ['v1', 'en`'],
    ['v1', 'x'],
    ['v1', 'en_US'],
    ['v1', 'not a tag'],
    ['v1', '1234'],
    ['v1', 'a'.repeat(36)],
  ])('refuses version %s with locale %s', (version, locale) => {
    expect(parseSearchPin({ version, locale })).toBeNull();
  });

  it('refuses values that are not strings', () => {
    expect(parseVersionKey(1)).toBeNull();
    expect(parseLocaleTag(['en'])).toBeNull();
    expect(parseSearchPin({ version: null })).toBeNull();
  });

  it('only ever lets through letters, digits, dots and hyphens, so no value needs escaping', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (version, locale) => {
        const pin = parseSearchPin({ version, locale });
        if (pin === null) return;
        expect(pin.version).toMatch(/^[a-z0-9.-]+$/);
        expect(pin.locale).toMatch(/^[A-Za-z0-9-]+$/);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('parseSearchQuery', () => {
  it('trims and collapses whitespace and normalises to NFC', () => {
    expect(parseSearchQuery('  install\t\nguide ')).toEqual({ ok: true, query: 'install guide' });
    expect(parseSearchQuery('cafe\u0301')).toEqual({ ok: true, query: 'caf\u00e9' });
  });

  it('turns control and format characters into spaces', () => {
    expect(parseSearchQuery('a\u0000b\u200bc\u202ed')).toEqual({ ok: true, query: 'a b c d' });
  });

  it('refuses empty, blank and invisible only text', () => {
    for (const raw of ['', '   ', '\u200b\u200b', '\u0000']) {
      expect(parseSearchQuery(raw)).toEqual({ ok: false, reason: 'empty' });
    }
  });

  it('caps the raw query at 256 bytes, counting UTF-8 bytes', () => {
    expect(parseSearchQuery('a'.repeat(MAX_QUERY_BYTES)).ok).toBe(true);
    expect(parseSearchQuery('a'.repeat(MAX_QUERY_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too_long',
    });
    // 86 three byte characters are 258 bytes but only 86 UTF-16 units.
    expect(parseSearchQuery('\u20ac'.repeat(86))).toEqual({ ok: false, reason: 'too_long' });
    // Stripped characters still count.
    expect(parseSearchQuery(`a${'\u200b'.repeat(90)}`)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('refuses anything but well formed text', () => {
    expect(parseSearchQuery(undefined)).toEqual({ ok: false, reason: 'not_text' });
    expect(parseSearchQuery(null)).toEqual({ ok: false, reason: 'not_text' });
    expect(parseSearchQuery(42)).toEqual({ ok: false, reason: 'not_text' });
    expect(parseSearchQuery('a\ud800b')).toEqual({ ok: false, reason: 'not_text' });
  });

  // Plain boolean checks, not expect, inside the property: a shared CI runner made 3000 runs of
  // expect calls pass the 5 s test timeout.
  it('for any input, an accepted query is short, clean and stable', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (raw) => {
        const parsed = parseSearchQuery(raw);
        if (!parsed.ok) return ['empty', 'too_long', 'not_text'].includes(parsed.reason);
        const again = parseSearchQuery(parsed.query);
        return (
          bytes(raw) <= MAX_QUERY_BYTES &&
          !/[\p{Cc}\p{Cf}]/u.test(parsed.query) &&
          parsed.query === parsed.query.trim() &&
          parsed.query !== '' &&
          again.ok &&
          again.query === parsed.query
        );
      }),
      { numRuns: 3000 },
    );
  }, 30_000);
});
