import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SealError, aesGcmSealer } from '../src/index.ts';
import { CONFIG_KEY, LABELS, runs } from './support.ts';

const keyId = fc.stringMatching(/^[a-z0-9]{1,8}$/);
const material = fc.uint8Array({ minLength: 32, maxLength: 64 });
const plain = fc.uint8Array({ minLength: 1, maxLength: 256 });
const bound = fc.array(fc.string({ unit: 'binary', maxLength: 40 }), {
  minLength: 1,
  maxLength: 4,
});

function refusal(work: () => unknown): string | null {
  try {
    work();
    return null;
  } catch (error) {
    return error instanceof SealError ? error.code : 'not a SealError';
  }
}

describe('aesGcmSealer properties', () => {
  it('opens a sealed value under the same bound values and never under others', () => {
    fc.assert(
      fc.property(keyId, material, plain, bound, bound, (id, bytes, secret, mine, theirs) => {
        const same =
          mine.length === theirs.length && mine.every((value, index) => value === theirs[index]);
        const sealer = aesGcmSealer([{ id, material: bytes }], LABELS, CONFIG_KEY);
        const row = sealer.seal(secret, mine);
        expect(sealer.open(row, mine).equals(Buffer.from(secret))).toBe(true);
        expect(refusal(() => sealer.open(row, theirs))).toBe(same ? null : 'SEAL_UNREADABLE');
      }),
      runs,
    );
  });

  it('refuses any single byte change to a sealed row', () => {
    fc.assert(
      fc.property(
        material,
        plain,
        bound,
        fc.boolean(),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (bytes, secret, values, inNonce, at, flip) => {
          const sealer = aesGcmSealer([{ id: 'k1', material: bytes }], LABELS, CONFIG_KEY);
          const row = sealer.seal(secret, values);
          const field = inNonce ? row.nonce : row.sealed;
          const bent = Buffer.from(field);
          const index = at % bent.length;
          bent[index] = (bent[index] ?? 0) ^ flip;
          const changed = inNonce ? { ...row, nonce: bent } : { ...row, sealed: bent };
          expect(refusal(() => sealer.open(changed, values))).toBe('SEAL_UNREADABLE');
        },
      ),
      runs,
    );
  });
});
