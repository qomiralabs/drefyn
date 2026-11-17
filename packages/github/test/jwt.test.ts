import { verify } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { appJwt } from '../src/jwt.ts';
import { loadAppSigner } from '../src/private-key.ts';
import { testKeys } from './support/keys.ts';

const keys = testKeys();
const signer = loadAppSigner(keys.privateKeyFile);

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString());

describe('appJwt', () => {
  it('is an RS256 token GitHub accepts: issued a minute back, under ten minutes long', () => {
    const now = 1_800_000_000_000;
    const token = appJwt(signer, 4242, now);
    const [header, payload, signature] = token.split('.');
    expect(decode(header ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payload ?? '')).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: '4242' });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header ?? ''}.${payload ?? ''}`),
        keys.publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
  });

  it('gives the same bytes for the same App and second, and never a padded segment', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 }),
        fc.integer({ min: 1_000_000_000_000, max: 4_000_000_000_000 }),
        (appId, now) => {
          const a = appJwt(signer, appId, now);
          expect(appJwt(signer, appId, now)).toBe(a);
          expect(a).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        },
      ),
      { numRuns: 25 },
    );
  });
});
