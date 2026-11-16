import { userId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { aesGcmSealer } from '../src/index.ts';
import { TOTP_SEAL_LABELS } from '../src/secret-sealer.ts';
import { expectAuthError } from './support.ts';

// Rows sealed by the sealer as it shipped in #544, at development 443606d4, with random
// nonces. They stand in for the TOTP secrets already stored in production: if any of these
// stop opening, every enrolled person is locked out of their second factor.
const VECTORS = [
  {
    keys: [{ id: 'k1', fill: 0x01, length: 32 }],
    user: '0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f',
    plain: '3132333435363738393031323334353637383930',
    keyId: 'k1',
    nonce: '5f653cc20631fdb1e7c5a0ac',
    sealed: 'b832e44e85f932555ef7066a7c8237df09218236615035bebacc96f7faae2b0433c1771b',
  },
  {
    keys: [
      { id: 'r2026', fill: 0xa5, length: 48 },
      { id: 'k1', fill: 0x01, length: 32 },
    ],
    user: '01934c1e-7a2b-7c3d-8e4f-5a6b7c8d9e0f',
    plain: '0b30557a9fc4e90e33587da2c7ec11365b80a5ca',
    keyId: 'r2026',
    nonce: 'e806e8c61268e9f6b8a6b123',
    sealed: '750e997b7522e2270b41e1bb29a4f951992baf3cb9e176775bdc8022445edc068a71a283',
  },
  {
    keys: [{ id: 'z9', fill: 0x3c, length: 64 }],
    user: '0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f',
    plain: 'fffefdfcfbfaf9f8f7f6f5f4f3f2f1f0efeeedec',
    keyId: 'z9',
    nonce: '1910cacfeeae1dd6fe740c43',
    sealed: '32fff8156ec4aa53e0447fd1b43176614f0b9b172a39eb5df5530099eca740372cf644f1',
  },
] as const;

const sealerFor = (vector: (typeof VECTORS)[number]) =>
  aesGcmSealer(
    vector.keys.map((key) => ({ id: key.id, material: new Uint8Array(key.length).fill(key.fill) })),
  );

const rowOf = (vector: (typeof VECTORS)[number]) => ({
  keyId: vector.keyId,
  nonce: Buffer.from(vector.nonce, 'hex'),
  sealed: Buffer.from(vector.sealed, 'hex'),
});

describe('secrets sealed before the move to @drefyn/seal', () => {
  it.each(VECTORS)('still open under key $keyId', (vector) => {
    const opened = sealerFor(vector).open(rowOf(vector), { userId: userId(vector.user) });
    expect(opened.toString('hex')).toBe(vector.plain);
  });

  it.each(VECTORS)('still refuse another user under key $keyId', (vector) => {
    const other = vector.user.startsWith('0192')
      ? '01934c1e-7a2b-7c3d-8e4f-5a6b7c8d9e0f'
      : '0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f';
    expectAuthError(
      () => sealerFor(vector).open(rowOf(vector), { userId: userId(other) }),
      'AUTH_UNAVAILABLE',
    );
  });

  it('opens a row sealed after a rotation under the key that sealed it', () => {
    const first = VECTORS[0];
    const rotated = aesGcmSealer([
      { id: 'n1', material: new Uint8Array(32).fill(0x77) },
      { id: 'k1', material: new Uint8Array(32).fill(0x01) },
    ]);
    const opened = rotated.open(rowOf(first), { userId: userId(first.user) });
    expect(opened.toString('hex')).toBe(first.plain);
  });

  // Versioned rather than edited. A new label needs a rekey, not a change here.
  it('keeps the second factor labels', () => {
    expect(TOTP_SEAL_LABELS).toEqual({
      hkdfSalt: 'drefyn.auth.totp.v1',
      hkdfInfo: 'drefyn/auth/v1/totp',
      aadVersion: 'drefyn.totp_secret.v1',
    });
    expect(Object.isFrozen(TOTP_SEAL_LABELS)).toBe(true);
  });
});
