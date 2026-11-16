import { userId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AuthError, aesGcmSealer } from '../src/index.ts';
import { anyUuid, runs } from './support.ts';

const keyId = fc.stringMatching(/^[a-z0-9]{1,8}$/);
const material = fc.uint8Array({ minLength: 32, maxLength: 64 });
const plain = fc.uint8Array({ minLength: 1, maxLength: 64 });

function refusal(work: () => unknown): string | null {
  try {
    work();
    return null;
  } catch (error) {
    return error instanceof AuthError ? error.code : 'not an AuthError';
  }
}

describe('aesGcmSealer properties', () => {
  it('opens a sealed value under its own user id and never under another', () => {
    fc.assert(
      fc.property(keyId, material, plain, anyUuid, anyUuid, (id, bytes, secret, owner, other) => {
        fc.pre(owner !== other);
        const sealer = aesGcmSealer([{ id, material: bytes }]);
        const row = sealer.seal(secret, { userId: userId(owner) });
        expect(sealer.open(row, { userId: userId(owner) }).equals(Buffer.from(secret))).toBe(true);
        expect(refusal(() => sealer.open(row, { userId: userId(other) }))).toBe('AUTH_UNAVAILABLE');
      }),
      runs,
    );
  });

  it('refuses any single byte change to a sealed row', () => {
    fc.assert(
      fc.property(
        material,
        plain,
        anyUuid,
        fc.boolean(),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (bytes, secret, owner, inNonce, at, flip) => {
          const sealer = aesGcmSealer([{ id: 'k1', material: bytes }]);
          const context = { userId: userId(owner) };
          const row = sealer.seal(secret, context);
          const field = inNonce ? row.nonce : row.sealed;
          const bent = Buffer.from(field);
          const index = at % bent.length;
          bent[index] = (bent[index] ?? 0) ^ flip;
          const changed = inNonce ? { ...row, nonce: bent } : { ...row, sealed: bent };
          expect(refusal(() => sealer.open(changed, context))).toBe('AUTH_UNAVAILABLE');
        },
      ),
      runs,
    );
  });
});
