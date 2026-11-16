import { describe, expect, it } from 'vitest';
import { aesGcmSealer } from '../src/index.ts';
import { expectSealError } from './support.ts';

// A second factor row sealed by the auth sealer before this package existed. Auth's labels
// and its one bound value, the user id, must open it here byte for byte.
const AUTH_LABELS = {
  hkdfSalt: 'drefyn.auth.totp.v1',
  hkdfInfo: 'drefyn/auth/v1/totp',
  aadVersion: 'drefyn.totp_secret.v1',
};
const USER = '0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f';
const ROW = {
  keyId: 'k1',
  nonce: Buffer.from('5f653cc20631fdb1e7c5a0ac', 'hex'),
  sealed: Buffer.from(
    'b832e44e85f932555ef7066a7c8237df09218236615035bebacc96f7faae2b0433c1771b',
    'hex',
  ),
};
const PLAIN = '3132333435363738393031323334353637383930';

const sealer = (labels = AUTH_LABELS) =>
  aesGcmSealer([{ id: 'k1', material: new Uint8Array(32).fill(1) }], labels, 'DREFYN_TEST_KEYS');

describe('a row sealed before the extraction', () => {
  it('opens under the auth labels and its user id', () => {
    expect(sealer().open(ROW, [USER]).toString('hex')).toBe(PLAIN);
  });

  it('opens under nothing else', () => {
    expectSealError(() => sealer().open(ROW, [USER, '']), 'SEAL_UNREADABLE');
    expectSealError(
      () => sealer({ ...AUTH_LABELS, aadVersion: 'drefyn.totp_secret.v2' }).open(ROW, [USER]),
      'SEAL_UNREADABLE',
    );
  });
});
