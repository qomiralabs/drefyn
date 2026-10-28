import { describe, expect, it } from 'vitest';
import {
  isNormalizedEmailAddress,
  normalizeEmailAddress,
  type AddressError,
} from '../src/index.ts';

type Reason = AddressError['reason'];

function reasonOf(input: string): Reason | 'accepted' {
  const result = normalizeEmailAddress(input);
  return result.ok ? 'accepted' : result.error.reason;
}

function valueOf(input: string): string {
  const result = normalizeEmailAddress(input);
  if (!result.ok) throw new Error(`refused with ${result.error.reason}`);
  return result.value;
}

// Each Unicode label is 7 units and 14 once encoded, so the ASCII form outgrows the input.
const growing = `${'a'.repeat(64)}@${'bücher.'.repeat(17)}com`;
const at254 = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;

const refusals: readonly (readonly [string, string, Reason])[] = [
  ['over 254 characters', `a${at254}`, 'length'],
  ['far over the scan bound', 'a'.repeat(2000), 'length'],
  ['an ASCII form over 254', growing, 'length'],

  ['a CR', 'jane@exam\rple.com', 'control'],
  ['an LF', 'jane@example.com\n', 'control'],
  ['a CRLF before the address', '\r\njane@example.com', 'control'],
  ['a NUL in the local part', 'jane\u0000@example.com', 'control'],
  ['a NUL at the end', 'jane@example.com\u0000', 'control'],
  ['a tab inside', 'jane\t@example.com', 'control'],
  ['a tab inside the domain', 'jane@ex\tample.com', 'control'],
  ['DEL', 'ja\u007fne@example.com', 'control'],
  ['a C1 control', 'jane@exa\u0085mple.com', 'control'],
  ['a line separator inside', 'ja ne@example.com', 'control'],

  ['no @', 'jane.example.com', 'shape'],
  ['a second @', 'jane@evil.test@example.com', 'shape'],
  ['a doubled @', 'jane@@example.com', 'shape'],
  ['an @ inside quotes', '"jane@x"@example.com', 'shape'],
  ['nothing at all', '', 'shape'],
  ['only padding', '   ', 'shape'],

  ['an empty local part', '@example.com', 'local_part'],
  ['a local part over 64', `${'a'.repeat(65)}@example.com`, 'local_part'],
  ['a non ASCII local part', 'jäne@example.com', 'local_part'],
  ['a homoglyph local part', 'jаne@example.com', 'local_part'],
  ['a quoted local part', '"jane"@example.com', 'local_part'],
  ['a quoted local part with a space', '"jane doe"@example.com', 'local_part'],
  ['a trailing comment', 'jane(comment)@example.com', 'local_part'],
  ['a leading comment', '(comment)jane@example.com', 'local_part'],
  ['a space', 'jane doe@example.com', 'local_part'],
  ['a backslash', 'ja\\ne@example.com', 'local_part'],
  ['angle brackets', 'jane<x>@example.com', 'local_part'],
  ['a comma', 'jane,doe@example.com', 'local_part'],
  ['a semicolon', 'jane;@example.com', 'local_part'],
  ['a colon', 'jane:@example.com', 'local_part'],
  ['square brackets', '[jane]@example.com', 'local_part'],
  ['a leading dot', '.jane@example.com', 'local_part'],
  ['a trailing dot', 'jane.@example.com', 'local_part'],
  ['two dots in a row', 'ja..ne@example.com', 'local_part'],

  ['an empty domain', 'jane@', 'domain'],
  ['a single label', 'jane@localhost', 'domain'],
  ['an IPv4 address', 'jane@192.0.2.1', 'domain'],
  ['an IPv4 address in hex', 'jane@0x7f.1', 'domain'],
  ['an address literal', 'jane@[192.0.2.1]', 'domain'],
  ['an IPv6 literal', 'jane@[::1]', 'domain'],
  ['a comment before the domain', 'jane@(comment)example.com', 'domain'],
  ['a comment after the domain', 'jane@example.com(comment)', 'domain'],
  ['a space in the domain', 'jane@exa mple.com', 'domain'],
  ['a leading hyphen', 'jane@-example.com', 'domain'],
  ['a trailing hyphen', 'jane@example-.com', 'domain'],
  ['an empty label', 'jane@exa..mple.com', 'domain'],
  ['a trailing dot', 'jane@example.com.', 'domain'],
  ['an underscore', 'jane@exa_mple.com', 'domain'],
  ['a label over 63', `jane@${'b'.repeat(64)}.com`, 'domain'],
  ['an ASCII domain over 253', `j@${'bücher.'.repeat(18)}com`, 'domain'],
  ['a port', 'jane@example.com:25', 'domain'],
  // The URL host parser would cut these off or decode them and keep the rest, turning a
  // string that is not an address into someone's real address.
  ['a path', 'jane@example.com/evil', 'domain'],
  ['a query', 'jane@example.com?evil', 'domain'],
  ['a fragment', 'jane@example.com#evil', 'domain'],
  ['a backslash in the domain', 'jane@example.com\\evil', 'domain'],
  ['a percent escape', 'jane@ex%41mple.com', 'domain'],
  ['a character IDNA forbids', 'jane@exa／mple.com', 'domain'],
  ['a lone surrogate', 'jane@exa\ud800mple.com', 'domain'],
  ['only ignorable characters in a label', 'jane@​.com', 'domain'],
];

describe('normalizeEmailAddress refusals', () => {
  it.each(refusals)('refuses %s', (_name, input, reason) => {
    expect(normalizeEmailAddress(input)).toEqual({
      ok: false,
      error: { code: 'address.invalid', reason },
    });
  });

  it('sizes the length cases as described', () => {
    expect(at254).toHaveLength(254);
    expect(growing.length).toBeLessThanOrEqual(254);
  });

  it('never echoes the input in the error', () => {
    const result = normalizeEmailAddress('"secret"@example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.error).sort()).toEqual(['code', 'reason']);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('normalizeEmailAddress accepted forms', () => {
  it('lower cases both halves with no dot or plus folding', () => {
    expect(valueOf('a.b+c@Example.COM')).toBe('a.b+c@example.com');
    expect(valueOf('A.B+C@example.com')).toBe('a.b+c@example.com');
    expect(valueOf('a.b+c@example.com')).not.toBe(valueOf('ab@example.com'));
    expect(valueOf('a.b+c@example.com')).not.toBe(valueOf('a.b@example.com'));
  });

  it('trims surrounding whitespace', () => {
    expect(valueOf('  Jane.Doe+Docs@Example.COM ')).toBe('jane.doe+docs@example.com');
    expect(valueOf('\tjane@example.com ')).toBe('jane@example.com');
  });

  it('accepts exactly 254 characters', () => {
    expect(valueOf(at254)).toBe(at254);
  });

  it('accepts every dot atom character in the local part', () => {
    expect(valueOf("!#$%&'*+-/=?^_`{|}~@example.com")).toBe("!#$%&'*+-/=?^_`{|}~@example.com");
  });

  it('returns a Unicode domain in its ASCII form', () => {
    expect(valueOf('max@Bücher.example')).toBe('max@xn--bcher-kva.example');
    expect(valueOf('max@xn--bcher-kva.example')).toBe('max@xn--bcher-kva.example');
    expect(valueOf('max@faß.de')).toBe('max@xn--fa-hia.de');
  });

  it('applies the IDNA mapping to full width forms', () => {
    expect(valueOf('jane@ｅxample.com')).toBe('jane@example.com');
    expect(valueOf('jane@example。com')).toBe('jane@example.com');
  });

  it('accepts digits and hyphens inside labels', () => {
    expect(valueOf('jane@mail-1.example2.co')).toBe('jane@mail-1.example2.co');
  });
});

describe('isNormalizedEmailAddress', () => {
  it('is true only for the normalised form itself', () => {
    expect(isNormalizedEmailAddress('a.b+c@example.com')).toBe(true);
    expect(isNormalizedEmailAddress('max@xn--bcher-kva.example')).toBe(true);
    for (const value of [
      'a.b+c@Example.COM',
      'A@example.com',
      ' a@example.com',
      'a@example.com ',
      'max@Bücher.example',
      'max@bücher.example',
      'jane@ｅxample.com',
      'jane@example.com/evil',
      'jane@localhost',
      '',
    ]) {
      expect(isNormalizedEmailAddress(value), JSON.stringify(value)).toBe(false);
    }
  });
});
