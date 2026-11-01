import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PASSWORD_FORM_MAX_BYTES,
  PASSWORD_MAX_BYTES,
  PASSWORD_RAW_MAX_BYTES,
  checkNewPassword,
  normalizePassword,
  readPasswordSignInForm,
} from '../src/index.ts';
import { caught } from './support.ts';

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const GOOD = {
  email: 'person@example.com',
  password: 'a long and quiet sentence',
  csrf: 'x'.repeat(43),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('caps before NFKC', () => {
  it('has the limits the form promises', () => {
    expect(PASSWORD_FORM_MAX_BYTES).toBe(8 * 1024);
    expect(PASSWORD_RAW_MAX_BYTES).toBe(4 * 1024);
    expect(PASSWORD_MAX_BYTES).toBe(1024);
  });

  it('refuses a body over 8 KiB without parsing or normalising it', () => {
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const body = form({ ...GOOD, padding: 'p'.repeat(PASSWORD_FORM_MAX_BYTES) });
    expect(caught(() => readPasswordSignInForm(body))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
    expect(caught(() => readPasswordSignInForm(Buffer.from(body)))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
    expect(normalize).not.toHaveBeenCalled();
  });

  it('counts the body in bytes, not characters', () => {
    // 2,800 characters of three bytes each: under 8,192 characters, over 8 KiB.
    const body = form({ ...GOOD, password: '\u20ac'.repeat(2_800) });
    expect(caught(() => readPasswordSignInForm(body))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
  });

  it('refuses a password field over 4 KiB raw before NFKC', () => {
    const normalize = vi.spyOn(String.prototype, 'normalize');
    const password = 'a'.repeat(PASSWORD_RAW_MAX_BYTES + 1);
    expect(caught(() => normalizePassword(password))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
    expect(normalize).not.toHaveBeenCalled();
  });

  it('refuses a password that grows past 1,024 bytes under NFKC', () => {
    // U+FDFA is 3 bytes and becomes 18 letters (33 bytes) under NFKC.
    const password = '\ufdfa'.repeat(40);
    expect(Buffer.byteLength(password)).toBeLessThan(PASSWORD_RAW_MAX_BYTES);
    expect(caught(() => normalizePassword(password))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
  });

  it('takes exactly 1,024 bytes after NFKC', () => {
    expect(normalizePassword('b'.repeat(1_024))).toHaveLength(1_024);
    expect(caught(() => normalizePassword('b'.repeat(1_025)))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
  });

  it('normalises to NFKC', () => {
    expect(normalizePassword('\uff21\u00bd cafe\u0301')).toBe('A1\u20442 caf\u00e9');
  });

  it('refuses a lone surrogate, which has no stable bytes', () => {
    expect(caught(() => normalizePassword(`abc\ud800def`))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
  });
});

describe('readPasswordSignInForm', () => {
  it('reads the fields a sign in posts', () => {
    expect(readPasswordSignInForm(form({ ...GOOD, returnTo: '/acme', botToken: 't' }))).toEqual({
      ...GOOD,
      returnTo: '/acme',
      botToken: 't',
    });
    expect(readPasswordSignInForm(form(GOOD))).toEqual(GOOD);
  });

  it.each([
    ['no email', { password: GOOD.password, csrf: GOOD.csrf }],
    ['no password', { email: GOOD.email, csrf: GOOD.csrf }],
    ['no binding field', { email: GOOD.email, password: GOOD.password }],
    ['an empty password', { ...GOOD, password: '' }],
    ['a long address', { ...GOOD, email: `${'a'.repeat(300)}@example.com` }],
    ['a long binding field', { ...GOOD, csrf: 'x'.repeat(200) }],
  ])('refuses %s', (_name, fields) => {
    expect(caught(() => readPasswordSignInForm(form(fields)))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
  });

  it('refuses a field sent twice, so no copy can slip past a check', () => {
    const body = `${form(GOOD)}&password=second`;
    expect(caught(() => readPasswordSignInForm(body))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
  });

  it('refuses a password field over 4 KiB inside a body under 8 KiB', () => {
    const body = form({ ...GOOD, password: 'q'.repeat(PASSWORD_RAW_MAX_BYTES + 1) });
    expect(Buffer.byteLength(body)).toBeLessThan(PASSWORD_FORM_MAX_BYTES);
    expect(caught(() => readPasswordSignInForm(body))).toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
  });
});

describe('checkNewPassword', () => {
  it('takes 15 to 128 characters after NFKC', () => {
    expect(checkNewPassword('a quiet harbour', {})).toEqual([]);
    expect(checkNewPassword('a quiet harbou', {})).toEqual(['too_short']);
    const longest = 'plum river '.repeat(12).slice(0, 128);
    expect(checkNewPassword(longest, {})).toEqual([]);
    expect(checkNewPassword(`${longest}x`, {})).toEqual(['too_long']);
  });

  it('counts characters, not UTF-16 units', () => {
    // Fifteen astral characters are thirty UTF-16 units.
    const astral = '\u{1f600}\u{1f3b5}\u{1f30a}\u{1f332}\u{1f319}'.repeat(3);
    expect(checkNewPassword(astral, {})).toEqual([]);
    expect(checkNewPassword(astral.slice(0, -2), {})).toEqual(['too_short']);
  });

  it('adds the built in common password rules', () => {
    expect(checkNewPassword('aaaaaaaaaaaaaaaa', {})).toContain('repeated_character');
    expect(checkNewPassword('my drefyn password', {})).toContain('context');
    expect(checkNewPassword('river person song', { email: 'person@example.com' })).toContain(
      'context',
    );
  });
});
