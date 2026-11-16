import { inspect } from 'node:util';
import { userId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { AUTH_CONFIG_KEYS, parseApiAuthConfig, parseAuthConfig } from '../src/index.ts';
import { UUID_A, base64url, caught, expectAuthError, validEnv } from './support.ts';

type Env = Record<string, string | undefined>;

const KEYS = 'DREFYN_AUTH_TOTP_KEYS';
const ISSUER = 'DREFYN_AUTH_TOTP_ISSUER';
const ONE = base64url(new Uint8Array(32).fill(21));
const TWO = base64url(new Uint8Array(32).fill(22));
const ALICE = { userId: userId(UUID_A) };
const SECRET = new Uint8Array(20).fill(5);

const env = (patch: Env = {}): Env => ({ ...validEnv(), ...patch });

function refused(patch: Env, key: typeof KEYS | typeof ISSUER) {
  return expectAuthError(() => parseAuthConfig(env(patch)), 'AUTH_CONFIG_INVALID', key);
}

describe('DREFYN_AUTH_TOTP_KEYS', () => {
  it('is a known setting', () => {
    expect(AUTH_CONFIG_KEYS).toContain(KEYS);
    expect(AUTH_CONFIG_KEYS).toContain(ISSUER);
  });

  it('when unset, reports enrolment unavailable and still starts', () => {
    for (const value of [undefined, '']) {
      const config = parseAuthConfig(env({ [KEYS]: value }));
      expect(config.totp.available).toBe(false);
      expect(config.totp.sealer).toBeNull();
      expect(config.totp.issuer).toBe('Drefyn');
    }
  });

  it('seals with the first key and opens with every key listed', () => {
    const old = parseAuthConfig(env({ [KEYS]: `k1:${ONE}` }));
    expect(old.totp.available).toBe(true);
    const row = old.totp.sealer?.seal(SECRET, ALICE);
    if (row === undefined) throw new Error('expected a sealer');
    expect(row.keyId).toBe('k1');

    const rotated = parseAuthConfig(env({ [KEYS]: `k2:${TWO},k1:${ONE}` }));
    expect(rotated.totp.sealer?.open(row, ALICE).equals(Buffer.from(SECRET))).toBe(true);
    expect(rotated.totp.sealer?.seal(SECRET, ALICE).keyId).toBe('k2');
  });

  it('takes a key longer than 32 bytes', () => {
    const long = base64url(new Uint8Array(48).fill(3));
    expect(parseAuthConfig(env({ [KEYS]: `a:${long}` })).totp.available).toBe(true);
  });

  it('refuses a malformed entry', () => {
    for (const value of [
      ONE,
      `:${ONE}`,
      `k1:`,
      `k1:${ONE},`,
      `,k1:${ONE}`,
      `k1 :${ONE}`,
      `k1: ${ONE}`,
      ` k1:${ONE}`,
      `K1:${ONE}`,
      `k-1:${ONE}`,
      `abcdefghi:${ONE}`,
      `k1:${ONE}=`,
      `k1:${ONE.replace(/^./, '+')}`,
      `k1:${ONE}:x`,
      `k1:${ONE};k2:${TWO}`,
      `k1:${ONE}, k2:${TWO}`,
    ]) {
      refused({ [KEYS]: value }, KEYS);
    }
  });

  it('refuses a key under 32 bytes', () => {
    refused({ [KEYS]: `k1:${base64url(new Uint8Array(31).fill(1))}` }, KEYS);
    refused({ [KEYS]: `k1:${ONE},k2:${base64url(new Uint8Array(16).fill(1))}` }, KEYS);
  });

  // The last character of a 32 byte value carries two spare bits, so a second spelling of
  // the same key would decode to the same bytes.
  it('refuses a key that is not canonical base64url', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(ONE.at(-1) ?? '');
    const twin = `${ONE.slice(0, -1)}${alphabet[last ^ 1] ?? ''}`;
    expect(Buffer.from(twin, 'base64url').equals(Buffer.from(ONE, 'base64url'))).toBe(true);
    refused({ [KEYS]: `k1:${twin}` }, KEYS);
  });

  it('refuses a repeated id', () => {
    refused({ [KEYS]: `k1:${ONE},k1:${TWO}` }, KEYS);
    refused({ [KEYS]: `a:${ONE},b:${TWO},a:${ONE}` }, KEYS);
  });

  it('refuses more than eight keys', () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `k${i}:${ONE}`).join(',');
    expect(parseAuthConfig(env({ [KEYS]: list(8) })).totp.available).toBe(true);
    refused({ [KEYS]: list(9) }, KEYS);
  });

  it('names the key and never the value or the id in a refusal', () => {
    const short = base64url(new Uint8Array(20).fill(77));
    for (const value of [
      `secretid:${short}`,
      `secretid:${ONE},secretid:${TWO}`,
      `secretid:${ONE}=`,
      `secretid:${ONE},Bad:${TWO}`,
    ]) {
      const error = caught(() => parseAuthConfig(env({ [KEYS]: value })));
      const text = [
        String(error),
        (error as Error).stack ?? '',
        JSON.stringify(error),
        inspect(error, { depth: 5 }),
      ].join('\n');
      expect(text).toContain(KEYS);
      for (const part of [value, short, ONE, TWO, 'secretid']) expect(text).not.toContain(part);
      expect(Object.keys(error as object).sort()).toEqual(['code', 'key']);
    }
  });

  it('never shows the key material, however the config is printed', () => {
    const config = parseAuthConfig(env({ [KEYS]: `k2:${TWO},k1:${ONE}` }));
    const printed = [
      JSON.stringify(config),
      inspect(config, { depth: 10, showHidden: true }),
      inspect(config.totp.sealer, { depth: 10, showHidden: true }),
    ].join('\n');
    for (const value of [ONE, TWO]) {
      const bytes = Buffer.from(value, 'base64url');
      expect(printed).not.toContain(value);
      expect(printed).not.toContain(bytes.toString('hex'));
      expect(printed).not.toContain(bytes.toString('base64'));
    }
  });

  it('keeps the sealer frozen inside the frozen config', () => {
    const config = parseAuthConfig(env({ [KEYS]: `k1:${ONE}` }));
    expect(Object.isFrozen(config.totp)).toBe(true);
    expect(Object.isFrozen(config.totp.sealer)).toBe(true);
  });

  it('stops the API service from starting when set', () => {
    const api = { DREFYN_API_RATE_LIMIT_KEY: TWO };
    expectAuthError(
      () => parseApiAuthConfig({ ...api, [KEYS]: `k1:${ONE}` }),
      'AUTH_CONFIG_INVALID',
      KEYS,
    );
    expectAuthError(
      () => parseApiAuthConfig({ ...api, [ISSUER]: 'Drefyn' }),
      'AUTH_CONFIG_INVALID',
      ISSUER,
    );
    expect(parseApiAuthConfig({ ...api, [KEYS]: '' }).apiKeyFail).toHaveLength(1);
  });
});

describe('DREFYN_AUTH_TOTP_ISSUER', () => {
  it('reads 1 to 64 printable characters', () => {
    for (const value of ['A', 'Acme Docs', 'acme.example', 'x'.repeat(64), 'Acme (staging) #2']) {
      expect(parseAuthConfig(env({ [ISSUER]: value })).totp.issuer).toBe(value);
    }
  });

  it('defaults when empty, the way compose passes an unset value', () => {
    expect(parseAuthConfig(env({ [ISSUER]: '' })).totp.issuer).toBe('Drefyn');
  });

  // A colon splits the label an authenticator shows into issuer and account.
  it('refuses more than 64 characters, a colon, control characters and edge spaces', () => {
    for (const value of [
      'x'.repeat(65),
      'Acme:Docs',
      'Acme\nDocs',
      'Acme\tDocs',
      'Acme\u0000',
      'Acme\u007f',
      ' Acme',
      'Acme ',
      'Acme Docs',
    ]) {
      refused({ [ISSUER]: value }, ISSUER);
    }
  });
});
