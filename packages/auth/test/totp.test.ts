import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCEPTED_TOTP_STEPS,
  AUTH_CONFIG_KEYS,
  TOTP_SECRET_BYTES,
  base32Encode,
  matchTotp,
  newTotpSecret,
  otpauthUri,
  parseAuthConfig,
  totpCode,
} from '../src/index.ts';
import { hotp } from '../src/totp.ts';
import { validEnv } from './support.ts';

// Counts every HMAC and every constant time compare, so the test can prove both steps
// always run. The originals still do the work.
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof crypto>();
  return {
    ...real,
    createHmac: vi.fn(real.createHmac),
    timingSafeEqual: vi.fn(real.timingSafeEqual),
  };
});

// The RFC 6238 appendix B secret for SHA-1: the ASCII digits 1 to 0, twice.
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const step = (seconds: number) => Math.floor(seconds / 30);

afterEach(() => {
  vi.mocked(crypto.createHmac).mockClear();
  vi.mocked(crypto.timingSafeEqual).mockClear();
});

describe('hotp and totpCode', () => {
  it('passes every RFC 4226 appendix D value', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];
    expected.forEach((code, counter) => {
      expect(hotp(RFC_SECRET, counter, 6)).toBe(code);
    });
  });

  it('passes every RFC 6238 appendix B SHA-1 value, at 8 digits and at the 6 we use', () => {
    const vectors: readonly [number, string][] = [
      [59, '94287082'],
      [1_111_111_109, '07081804'],
      [1_111_111_111, '14050471'],
      [1_234_567_890, '89005924'],
      [2_000_000_000, '69279037'],
      [20_000_000_000, '65353130'],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(RFC_SECRET, step(seconds), 8)).toBe(code);
      expect(totpCode(RFC_SECRET, step(seconds))).toBe(code.slice(2));
    }
  });

  it('refuses a step that is not a whole number from 0', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => totpCode(RFC_SECRET, bad)).toThrow(RangeError);
    }
  });

  it('makes a fresh 160 bit secret each time', () => {
    const one = newTotpSecret();
    expect(one).toHaveLength(TOTP_SECRET_BYTES);
    expect(TOTP_SECRET_BYTES).toBe(20);
    expect(one.equals(newTotpSecret())).toBe(false);
  });
});

describe('matchTotp at a fixed step', () => {
  const now = step(1_234_567_890);
  const at = (offset: number) => totpCode(RFC_SECRET, now + offset);

  it('accepts the current and the previous step', () => {
    expect(matchTotp(RFC_SECRET, at(0), now)).toBe(now);
    expect(matchTotp(RFC_SECRET, at(-1), now)).toBe(now - 1);
  });

  it('refuses the next step and two steps back', () => {
    // Guard against a code that happens to repeat across steps.
    expect(new Set([at(1), at(0), at(-1)]).size).toBe(3);
    expect(new Set([at(-2), at(0), at(-1)]).size).toBe(3);
    expect(matchTotp(RFC_SECRET, at(1), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, at(-2), now)).toBeNull();
  });

  it('returns the higher step when both match', () => {
    // Found by search: the RFC secret gives 911617 at steps 910737 and 910738.
    const s = 910_738;
    expect(totpCode(RFC_SECRET, s)).toBe('911617');
    expect(totpCode(RFC_SECRET, s - 1)).toBe('911617');
    expect(matchTotp(RFC_SECRET, '911617', s)).toBe(s);
  });

  it('takes typed gaps, and refuses any other shape', () => {
    const code = at(0);
    expect(matchTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(now);
    expect(matchTotp(RFC_SECRET, ` ${code}\t`, now)).toBe(now);
    for (const bad of [
      '',
      code.slice(1),
      `${code}0`,
      `${code.slice(0, 5)}a`,
      `${code.slice(0, 3)}-${code.slice(3)}`,
      // Fullwidth and Arabic Indic digits are digits to a regex with the u flag.
      '１２３４５６',
      '١٢٣٤٥٦',
      `${code}\u0000`,
      ' '.repeat(10_000),
    ]) {
      expect(matchTotp(RFC_SECRET, bad, now), JSON.stringify(bad.slice(0, 12))).toBeNull();
    }
  });

  it('refuses a current step below 1, which has no previous step', () => {
    expect(() => matchTotp(RFC_SECRET, '000000', 0)).toThrow(RangeError);
    expect(() => matchTotp(RFC_SECRET, '000000', 1.5)).toThrow(RangeError);
  });

  it('always computes and compares both steps, with no early exit', () => {
    const hmac = vi.mocked(crypto.createHmac);
    const compare = vi.mocked(crypto.timingSafeEqual);
    for (const typed of [at(0), at(-1), at(1), 'abcdef', '']) {
      hmac.mockClear();
      compare.mockClear();
      matchTotp(RFC_SECRET, typed, now);
      expect(hmac, typed).toHaveBeenCalledTimes(2);
      expect(compare, typed).toHaveBeenCalledTimes(2);
    }
  });
});

describe('the accepted step set', () => {
  it('is the current and previous step, frozen', () => {
    expect(ACCEPTED_TOTP_STEPS).toEqual([0, -1]);
    expect(Object.isFrozen(ACCEPTED_TOTP_STEPS)).toBe(true);
  });

  it('cannot be changed by config', () => {
    // No setting names a window, drift or step.
    for (const key of AUTH_CONFIG_KEYS) {
      expect(key).not.toMatch(/TOTP_(WINDOW|DRIFT|SKEW|STEP|PERIOD|DIGITS)/);
    }
    for (const key of [
      'DREFYN_AUTH_TOTP_WINDOW',
      'DREFYN_AUTH_TOTP_STEPS',
      'DREFYN_AUTH_TOTP_SKEW',
      'DREFYN_AUTH_TOTP_DRIFT',
    ]) {
      expect(() => parseAuthConfig({ ...validEnv(), [key]: '2' })).toThrow(/is not a known/);
    }
    // matchTotp takes no options, and its module reads no config.
    expect(matchTotp.length).toBe(3);
    const source = readFileSync(new URL('../src/totp.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from '\.\/config(-keys)?\.ts'/);
    expect(source).not.toMatch(/process\.env/);
  });
});

describe('base32Encode', () => {
  it('passes the RFC 4648 section 10 values, unpadded', () => {
    const vectors: readonly [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
    }
  });

  it('gives 32 characters for a 160 bit secret', () => {
    expect(base32Encode(RFC_SECRET)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });
});

describe('otpauthUri', () => {
  it('names the issuer twice and pins the algorithm, digits and period', () => {
    const uri = otpauthUri({ issuer: 'Drefyn', account: 'ada@example.com', secret: RFC_SECRET });
    expect(uri).toBe(
      'otpauth://totp/Drefyn:ada%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Drefyn&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('escapes the issuer and account, so neither can add a parameter or split the label', () => {
    const uri = otpauthUri({
      issuer: 'Acme & Co (docs)',
      account: 'a:b?c=d&e#f/g@example.com',
      secret: RFC_SECRET,
    });
    const url = new URL(uri);
    expect(url.protocol).toBe('otpauth:');
    expect([...url.searchParams.keys()]).toEqual([
      'secret',
      'issuer',
      'algorithm',
      'digits',
      'period',
    ]);
    expect(url.searchParams.get('issuer')).toBe('Acme & Co (docs)');
    const label = uri.slice('otpauth://totp/'.length, uri.indexOf('?'));
    expect(label.split(':').map(decodeURIComponent)).toEqual([
      'Acme & Co (docs)',
      'a:b?c=d&e#f/g@example.com',
    ]);
    expect(decodeURIComponent(label)).toBe('Acme & Co (docs):a:b?c=d&e#f/g@example.com');
    expect(uri.split(':').length).toBe(3);
    expect(url.hash).toBe('');
  });
});
