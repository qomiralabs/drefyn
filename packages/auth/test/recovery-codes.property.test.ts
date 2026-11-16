import * as crypto from 'node:crypto';
import { userId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { matchRecoveryCode, newRecoveryCodes, recoveryCodeHash } from '../src/index.ts';
import { CROCKFORD, anyUuid, runs } from './support.ts';

// Counts the compares underneath constantTimeEqual; the original still does the work.
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof crypto>();
  return { ...real, timingSafeEqual: vi.fn(real.timingSafeEqual) };
});

const plainCode = fc.string({
  unit: fc.constantFrom(...Array.from(CROCKFORD)),
  minLength: 24,
  maxLength: 24,
});

describe('recovery code properties', () => {
  it('refuses any input outside the hash set, and compares every row each time', () => {
    const compare = vi.mocked(crypto.timingSafeEqual);
    fc.assert(
      fc.property(
        anyUuid,
        fc.oneof(plainCode, fc.string({ maxLength: 40 })),
        fc.integer({ min: 1, max: 10 }),
        (owner, typed, count) => {
          const user = userId(owner);
          const issued = newRecoveryCodes(user).slice(0, count);
          const rows = issued.map((c, i) => ({ id: String(i), codeHash: c.hash }));
          const hash = recoveryCodeHash(user, typed);
          fc.pre(hash === null || !rows.some((r) => r.codeHash.equals(hash)));
          compare.mockClear();
          expect(matchRecoveryCode(user, typed, rows)).toBeNull();
          expect(compare).toHaveBeenCalledTimes(rows.length);
        },
      ),
      runs,
    );
  });

  it('compares all ten rows even when the first one matches', () => {
    const compare = vi.mocked(crypto.timingSafeEqual);
    fc.assert(
      fc.property(anyUuid, fc.integer({ min: 0, max: 9 }), (owner, which) => {
        const user = userId(owner);
        const issued = newRecoveryCodes(user);
        const rows = issued.map((c, i) => ({ id: String(i), codeHash: c.hash }));
        compare.mockClear();
        expect(matchRecoveryCode(user, issued[which]?.code ?? '', rows)).toBe(String(which));
        expect(compare).toHaveBeenCalledTimes(10);
      }),
      { ...runs, numRuns: 50 },
    );
  });

  it('never matches a code under another user id', () => {
    fc.assert(
      fc.property(anyUuid, anyUuid, fc.integer({ min: 0, max: 9 }), (owner, other, which) => {
        fc.pre(owner !== other);
        const issued = newRecoveryCodes(userId(owner));
        const rows = issued.map((c, i) => ({ id: String(i), codeHash: c.hash }));
        expect(matchRecoveryCode(userId(other), issued[which]?.code ?? '', rows)).toBeNull();
      }),
      { ...runs, numRuns: 100 },
    );
  });
});
