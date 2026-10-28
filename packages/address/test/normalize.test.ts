import { describe, expect, it } from 'vitest';
import {
  isNormalizedEmailAddress,
  normalizeEmailAddress,
  type AddressError,
} from '../src/index.ts';

type Reason = AddressError['reason'];

function valueOf(input: string): string {
  const result = normalizeEmailAddress(input);
  if (!result.ok) throw new Error(`refused with ${result.error.reason}`);
  return result.value;
}

// Each Unicode label is 7 units and 14 once encoded, so the ASCII form outgrows the input.
const growing = `${'a'.repeat(64)}@${'b\u00fccher.'.repeat(17)}com`;
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
  ['a line separator inside', 'ja\u2028ne@example.com', 'control'],

  ['no @', 'jane.example.com', 'shape'],
  ['a second @', 'jane@evil.test@example.com', 'shape'],
  ['a doubled @', 'jane@@example.com', 'shape'],
  ['an @ inside quotes', '"jane@x"@example.com', 'shape'],
  ['nothing at all', '', 'shape'],
  ['only padding', '   ', 'shape'],

  ['an empty local part', '@example.com', 'local_part'],
  ['a local part over 64', `${'a'.repeat(65)}@example.com`, 'local_part'],
  ['a non ASCII local part', 'j\u00e4ne@example.com', 'local_part'],
  ['a homoglyph local part', 'j\u0430ne@example.com', 'local_part'],
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
  ['an ASCII domain over 253', `j@${'b\u00fccher.'.repeat(18)}com`, 'domain'],
  ['a port', 'jane@example.com:25', 'domain'],
  // The URL host parser would cut these off or decode them and keep the rest, turning a
  // string that is not an address into someone's real address.
  ['a path', 'jane@example.com/evil', 'domain'],
  ['a query', 'jane@example.com?evil', 'domain'],
  ['a fragment', 'jane@example.com#evil', 'domain'],
  ['a backslash in the domain', 'jane@example.com\\evil', 'domain'],
  ['a percent escape', 'jane@ex%41mple.com', 'domain'],
  ['a character IDNA forbids', 'jane@exa\uff0fmple.com', 'domain'],
  ['a lone surrogate', 'jane@exa\ud800mple.com', 'domain'],
  ['only ignorable characters in a label', 'jane@\u200b.com', 'domain'],
  // Compatibility forms of the same delimiters. Some browsers fold them into the ASCII
  // character before splitting the host, so the check also runs on the NFKC form.
  ['a full width solidus', 'jane@example.com\uff0fevil', 'domain'],
  ['a full width question mark', 'jane@example.com\uff1fx', 'domain'],
  ['a full width number sign', 'jane@example.com\uff03x', 'domain'],
  ['a full width reverse solidus', 'jane@example.com\uff3cx', 'domain'],
  ['a full width colon', 'jane@example.com\uff1a25', 'domain'],
  ['a full width commercial at', 'jane@foo\uff20example.com', 'domain'],
  ['a small commercial at', 'jane@example.com\ufe6bevil.com', 'domain'],
  ['a full width percent escape', 'jane@ex\uff0541mple.com', 'domain'],
  ['a small percent escape', 'jane@ex\ufe6a41mple.com', 'domain'],
  ['a full width semicolon', 'jane@example\uff1bcom', 'domain'],
  ['an ideographic space', 'jane@exa\u3000mple.com', 'domain'],
  ['a small question mark', 'jane@example.com\ufe56x', 'domain'],
  ['a small number sign', 'jane@example.com\ufe5fx', 'domain'],
  ['a small reverse solidus', 'jane@example.com\ufe68x', 'domain'],
  ['a small colon', 'jane@example.com\ufe5525', 'domain'],
  ['an equals sign hidden by a combining overlay', 'jane@exa=\u0338mple.com', 'domain'],
  // Default ignorable code points vanish in IDNA, so a look alike input would match
  // another address without any visible sign.
  ['U+00AD inside the domain', 'jane@exa\u00admple.com', 'domain'],
  ['U+200B inside the domain', 'jane@exa\u200bmple.com', 'domain'],
  ['U+2060 inside the domain', 'jane@exa\u2060mple.com', 'domain'],
  ['U+FEFF inside the domain', 'jane@exa\ufeffmple.com', 'domain'],
  ['U+FE0F inside the domain', 'jane@exa\ufe0fmple.com', 'domain'],
  ['U+034F inside the domain', 'jane@exa\u034fmple.com', 'domain'],
  ['U+180B inside the domain', 'jane@exa\u180bmple.com', 'domain'],
  ['U+200C inside the domain', 'jane@exa\u200cmple.com', 'domain'],
  ['U+200D inside the domain', 'jane@exa\u200dmple.com', 'domain'],
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

  it('hands out refusals no caller can change for the next one', () => {
    const first = normalizeEmailAddress('jane@localhost');
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(Object.isFrozen(first.error)).toBe(true);
    expect(() => {
      (first.error as { reason: string }).reason = 'tampered';
    }).toThrow(TypeError);
    expect(normalizeEmailAddress('jane@example')).toEqual({
      ok: false,
      error: { code: 'address.invalid', reason: 'domain' },
    });
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
    expect(valueOf('\tjane@example.com\u00a0')).toBe('jane@example.com');
  });

  it('accepts exactly 254 characters', () => {
    expect(valueOf(at254)).toBe(at254);
  });

  it('accepts every dot atom character in the local part', () => {
    expect(valueOf("!#$%&'*+-/=?^_`{|}~@example.com")).toBe("!#$%&'*+-/=?^_`{|}~@example.com");
  });

  it('returns a Unicode domain in its ASCII form', () => {
    expect(valueOf('max@B\u00fccher.example')).toBe('max@xn--bcher-kva.example');
    expect(valueOf('max@xn--bcher-kva.example')).toBe('max@xn--bcher-kva.example');
    expect(valueOf('max@fa\u00df.de')).toBe('max@xn--fa-hia.de');
  });

  it('applies the IDNA mapping to full width forms', () => {
    expect(valueOf('jane@\uff45xample.com')).toBe('jane@example.com');
    expect(valueOf('jane@example\u3002com')).toBe('jane@example.com');
  });

  it('still accepts real internationalised domains after the compatibility check', () => {
    expect(valueOf('jane@\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.ir')).toBe(
      'jane@xn--mgbn2ecje63gr19l.ir',
    );
    expect(valueOf('jane@\u0915\u094d\u200d\u0937.in')).toBe('jane@xn--11b2ezcw70k.in');
    expect(valueOf('jane@m%sn.de'.replace('%s', '\u00fcnche'))).toBe('jane@xn--mnchen-3ya.de');
    expect(valueOf('jane@stra%se.de'.replace('%s', '\u00df'))).toBe('jane@xn--strae-oqa.de');
    expect(
      valueOf(
        'ivan@%s.%s'
          .replace('%s', '\u043f\u0440\u0438\u043c\u0435\u0440')
          .replace('%s', '\u0440\u0444'),
      ),
    ).toBe('ivan@xn--e1afmkfd.xn--p1ai');
    expect(valueOf('jane@example%scom'.replace('%s', '\uff61'))).toBe('jane@example.com');
  });

  // IDNA keeps a joiner where the script needs it and encodes it, so the spelling with
  // one is a different domain, not a hidden copy of the spelling without.
  it('stores a ZWNJ spelling apart from the joiner free one', () => {
    expect(valueOf('jane@\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.ir')).not.toBe(
      valueOf('jane@\u0645\u06cc\u062e\u0648\u0627\u0647\u0645.ir'),
    );
    expect(valueOf('jane@\u0645\u06cc\u062e\u0648\u0627\u0647\u0645.ir')).toBe(
      'jane@xn--mgbn2ecje63g.ir',
    );
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
      'max@B\u00fccher.example',
      'max@b\u00fccher.example',
      'jane@\uff45xample.com',
      'jane@example.com/evil',
      'jane@localhost',
      '',
    ]) {
      expect(isNormalizedEmailAddress(value), JSON.stringify(value)).toBe(false);
    }
  });
});
