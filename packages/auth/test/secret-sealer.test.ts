import { createCipheriv, createSecretKey, hkdfSync } from 'node:crypto';
import { userId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import { aesGcmSealer, lengthPrefixed, type SealingKey } from '../src/index.ts';
import { UUID_A, UUID_B, expectAuthError } from './support.ts';

const ALICE = { userId: userId(UUID_A) };
const BOB = { userId: userId(UUID_B) };
const SECRET = new Uint8Array(20).map((_, i) => i + 1);

const key = (id: string, fill: number, length = 32): SealingKey => ({
  id,
  material: new Uint8Array(length).fill(fill),
});

describe('aesGcmSealer', () => {
  it('opens what it sealed, under the first key', () => {
    const sealer = aesGcmSealer([key('k2', 2), key('k1', 1)]);
    const row = sealer.seal(SECRET, ALICE);
    expect(row.keyId).toBe('k2');
    expect(row.nonce).toHaveLength(12);
    // 20 bytes of cipher text and a 16 byte tag, the size the column allows.
    expect(row.sealed).toHaveLength(36);
    expect(Buffer.from(SECRET).equals(row.sealed.subarray(0, 20))).toBe(false);
    expect(sealer.open(row, ALICE).equals(Buffer.from(SECRET))).toBe(true);
  });

  it('opens a value sealed under any key it lists, so a rotation keeps every factor', () => {
    const old = aesGcmSealer([key('k1', 1)]).seal(SECRET, ALICE);
    const rotated = aesGcmSealer([key('k2', 2), key('k1', 1)]);
    expect(rotated.open(old, ALICE).equals(Buffer.from(SECRET))).toBe(true);
  });

  it('draws a fresh nonce for every seal', () => {
    const sealer = aesGcmSealer([key('k1', 1)]);
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i += 1) nonces.add(sealer.seal(SECRET, ALICE).nonce.toString('hex'));
    expect(nonces.size).toBe(200);
  });

  it('refuses a flipped byte anywhere in the nonce, cipher text or tag', () => {
    const sealer = aesGcmSealer([key('k1', 1)]);
    const row = sealer.seal(SECRET, ALICE);
    for (const field of ['nonce', 'sealed'] as const) {
      for (let i = 0; i < row[field].length; i += 1) {
        const bent = Buffer.from(row[field]);
        bent[i] = (bent[i] ?? 0) ^ 0x01;
        expectAuthError(() => sealer.open({ ...row, [field]: bent }, ALICE), 'AUTH_UNAVAILABLE');
      }
    }
  });

  it('refuses another user id', () => {
    const sealer = aesGcmSealer([key('k1', 1)]);
    expectAuthError(() => sealer.open(sealer.seal(SECRET, ALICE), BOB), 'AUTH_UNAVAILABLE');
  });

  it('refuses a changed key id, even one that names another listed key', () => {
    const sealer = aesGcmSealer([key('k1', 1), key('k2', 1)]);
    const row = sealer.seal(SECRET, ALICE);
    // Same material under both ids, so only the bound id can tell them apart.
    expectAuthError(() => sealer.open({ ...row, keyId: 'k2' }, ALICE), 'AUTH_UNAVAILABLE');
  });

  it('refuses an unknown key id', () => {
    const row = aesGcmSealer([key('k1', 1)]).seal(SECRET, ALICE);
    expectAuthError(() => aesGcmSealer([key('k2', 2)]).open(row, ALICE), 'AUTH_UNAVAILABLE');
    expectAuthError(() => aesGcmSealer([key('k1', 9)]).open(row, ALICE), 'AUTH_UNAVAILABLE');
  });

  it('refuses a nonce or sealed value of the wrong length before decrypting', () => {
    const sealer = aesGcmSealer([key('k1', 1)]);
    const row = sealer.seal(SECRET, ALICE);
    expectAuthError(
      () => sealer.open({ ...row, nonce: row.nonce.subarray(0, 11) }, ALICE),
      'AUTH_UNAVAILABLE',
    );
    expectAuthError(
      () => sealer.open({ ...row, nonce: Buffer.concat([row.nonce, Buffer.alloc(1)]) }, ALICE),
      'AUTH_UNAVAILABLE',
    );
    expectAuthError(
      () => sealer.open({ ...row, sealed: row.sealed.subarray(0, 15) }, ALICE),
      'AUTH_UNAVAILABLE',
    );
    expectAuthError(
      () => sealer.open({ ...row, sealed: row.sealed.subarray(0, 16) }, ALICE),
      'AUTH_UNAVAILABLE',
    );
  });

  // Pins the format: AES-256-GCM, an HKDF-SHA256 subkey, and associated data of version,
  // user and key id. Changing any of them strands every stored secret.
  it('seals in the stored format', () => {
    const material = new Uint8Array(32).fill(1);
    const nonce = Buffer.alloc(12, 3);
    const aesKey = createSecretKey(
      Buffer.from(hkdfSync('sha256', material, 'drefyn.auth.totp.v1', 'drefyn/auth/v1/totp', 32)),
    );
    const cipher = createCipheriv('aes-256-gcm', aesKey, nonce, { authTagLength: 16 });
    cipher.setAAD(lengthPrefixed(['drefyn.totp_secret.v1', UUID_A, 'k1']));
    const sealed = Buffer.concat([cipher.update(SECRET), cipher.final(), cipher.getAuthTag()]);
    const opened = aesGcmSealer([{ id: 'k1', material }]).open(
      { keyId: 'k1', nonce, sealed },
      ALICE,
    );
    expect(opened.equals(Buffer.from(SECRET))).toBe(true);
  });

  it('takes a key longer than 32 bytes', () => {
    const sealer = aesGcmSealer([key('k1', 1, 64)]);
    expect(sealer.open(sealer.seal(SECRET, ALICE), ALICE).equals(Buffer.from(SECRET))).toBe(true);
  });

  it('refuses to build with no key, a short key, a bad id or a repeated id', () => {
    expectAuthError(() => aesGcmSealer([]), 'AUTH_CONFIG_INVALID', 'DREFYN_AUTH_TOTP_KEYS');
    expectAuthError(
      () => aesGcmSealer([key('k1', 1, 31)]),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_TOTP_KEYS',
    );
    for (const id of ['', 'K1', 'k-1', 'abcdefghi', 'k 1']) {
      expectAuthError(
        () => aesGcmSealer([key(id, 1)]),
        'AUTH_CONFIG_INVALID',
        'DREFYN_AUTH_TOTP_KEYS',
      );
    }
    expectAuthError(
      () => aesGcmSealer([key('k1', 1), key('k1', 2)]),
      'AUTH_CONFIG_INVALID',
      'DREFYN_AUTH_TOTP_KEYS',
    );
  });

  it('does not share its caller buffers, so a later change to them cannot alter a key', () => {
    const material = new Uint8Array(32).fill(1);
    const sealer = aesGcmSealer([{ id: 'k1', material }]);
    const row = sealer.seal(SECRET, ALICE);
    material.fill(0);
    expect(sealer.open(row, ALICE).equals(Buffer.from(SECRET))).toBe(true);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(aesGcmSealer([key('k1', 1)]))).toBe(true);
  });
});
