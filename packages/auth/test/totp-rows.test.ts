import { userId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { aesGcmSealer, newTotpSecret, pendingTotpRow } from '../src/index.ts';
import { UUID_A } from './support.ts';

const ALICE = userId(UUID_A);

describe('pendingTotpRow', () => {
  const sealer = aesGcmSealer([{ id: 'k1', material: new Uint8Array(32).fill(1) }]);
  const sealed = sealer.seal(newTotpSecret(), { userId: ALICE });

  // The gate reads only confirmed rows, so a row that started confirmed would skip the
  // proof that the person's app shows the right codes.
  it('is what startEnrollment inserts: unconfirmed, unused and with no failures', () => {
    expect(pendingTotpRow(ALICE, sealed)).toEqual({
      user_id: UUID_A,
      key_id: 'k1',
      secret_nonce: sealed.nonce,
      secret_sealed: sealed.sealed,
      confirmed_at: null,
      last_used_step: null,
      last_used_at: null,
      failed_attempts: 0,
    });
  });

  it('fits the column checks', () => {
    const row = pendingTotpRow(ALICE, sealed);
    expect(row.secret_nonce).toHaveLength(12);
    expect(row.secret_sealed).toHaveLength(36);
    expect(row.key_id).toMatch(/^[a-z0-9]{1,8}$/);
  });
});
