import { createCipheriv, createSecretKey, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_SEAL_KEYS, aesGcmSealer, lengthPrefixed } from '../src/index.ts';
import { CONFIG_KEY, LABELS, expectSealError, key } from './support.ts';

const SECRET = new Uint8Array(20).map((_, i) => i + 1);
const ORG = '0192b7a4-5c1e-7d2a-9f3b-1a2b3c4d5e6f';
const ROW = '01934c1e-7a2b-7c3d-8e4f-5a6b7c8d9e0f';
const BOUND = [ORG, ROW] as const;

const sealerOf = (...keys: ReturnType<typeof key>[]) => aesGcmSealer(keys, LABELS, CONFIG_KEY);

describe('aesGcmSealer', () => {
  it('opens what it sealed, under the first key', () => {
    const sealer = sealerOf(key('k2', 2), key('k1', 1));
    const row = sealer.seal(SECRET, BOUND);
    expect(row.keyId).toBe('k2');
    expect(row.nonce).toHaveLength(12);
    expect(row.sealed).toHaveLength(SECRET.length + 16);
    expect(Buffer.from(SECRET).equals(row.sealed.subarray(0, 20))).toBe(false);
    expect(sealer.open(row, BOUND).equals(Buffer.from(SECRET))).toBe(true);
    expect(Object.isFrozen(row)).toBe(true);
  });

  it('opens a value sealed under any key it lists, so a rotation keeps every secret', () => {
    const old = sealerOf(key('k1', 1)).seal(SECRET, BOUND);
    expect(sealerOf(key('k2', 2), key('k1', 1)).open(old, BOUND).equals(Buffer.from(SECRET))).toBe(
      true,
    );
  });

  it('draws a fresh nonce for every seal', () => {
    const sealer = sealerOf(key('k1', 1));
    const nonces = new Set<string>();
    for (let i = 0; i < 200; i += 1) nonces.add(sealer.seal(SECRET, BOUND).nonce.toString('hex'));
    expect(nonces.size).toBe(200);
  });

  it('takes a key longer than 32 bytes', () => {
    const sealer = sealerOf(key('k1', 1, 64));
    expect(sealer.open(sealer.seal(SECRET, BOUND), BOUND).equals(Buffer.from(SECRET))).toBe(true);
  });

  it('does not share its caller buffers, so a later change to them cannot alter a key', () => {
    const material = new Uint8Array(32).fill(1);
    const sealer = aesGcmSealer([{ id: 'k1', material }], LABELS, CONFIG_KEY);
    const row = sealer.seal(SECRET, BOUND);
    material.fill(0);
    expect(sealer.open(row, BOUND).equals(Buffer.from(SECRET))).toBe(true);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(sealerOf(key('k1', 1)))).toBe(true);
  });

  // Pins the format: AES-256-GCM, an HKDF-SHA256 subkey from the salt and info labels, and
  // associated data of the version label, the bound values in order, then the key id.
  it('seals in the stored format', () => {
    const material = new Uint8Array(32).fill(1);
    const nonce = Buffer.alloc(12, 3);
    const aesKey = createSecretKey(
      Buffer.from(hkdfSync('sha256', material, LABELS.hkdfSalt, LABELS.hkdfInfo, 32)),
    );
    const cipher = createCipheriv('aes-256-gcm', aesKey, nonce, { authTagLength: 16 });
    cipher.setAAD(lengthPrefixed([LABELS.aadVersion, ORG, ROW, 'k1']));
    const sealed = Buffer.concat([cipher.update(SECRET), cipher.final(), cipher.getAuthTag()]);
    const opened = sealerOf({ id: 'k1', material }).open({ keyId: 'k1', nonce, sealed }, BOUND);
    expect(opened.equals(Buffer.from(SECRET))).toBe(true);
  });
});

describe('lengthPrefixed', () => {
  it('puts a 4 byte big endian length before each UTF-8 part', () => {
    expect(lengthPrefixed(['ab', 'é']).toString('hex')).toBe('000000026162' + '00000002c3a9');
    expect(lengthPrefixed([]).length).toBe(0);
  });

  it('keeps a byte from moving between parts', () => {
    expect(lengthPrefixed(['ab', 'c']).equals(lengthPrefixed(['a', 'bc']))).toBe(false);
  });
});

describe('aesGcmSealer fails closed', () => {
  it('refuses a flipped byte anywhere in the nonce, cipher text or tag', () => {
    const sealer = sealerOf(key('k1', 1));
    const row = sealer.seal(SECRET, BOUND);
    for (const field of ['nonce', 'sealed'] as const) {
      for (let i = 0; i < row[field].length; i += 1) {
        const bent = Buffer.from(row[field]);
        bent[i] = (bent[i] ?? 0) ^ 0x01;
        expectSealError(() => sealer.open({ ...row, [field]: bent }, BOUND), 'SEAL_UNREADABLE');
      }
    }
  });

  it('refuses wrong bound values, in any position, count or split', () => {
    const sealer = sealerOf(key('k1', 1));
    const row = sealer.seal(SECRET, ['ab', 'c']);
    for (const bound of [['ab', 'd'], ['c', 'ab'], ['a', 'bc'], ['abc'], ['ab'], ['ab', 'c', '']]) {
      expectSealError(() => sealer.open(row, bound), 'SEAL_UNREADABLE');
    }
  });

  it('refuses no bound values at all, on seal and on open', () => {
    const sealer = sealerOf(key('k1', 1));
    const row = sealer.seal(SECRET, BOUND);
    expectSealError(() => sealer.seal(SECRET, []), 'SEAL_UNBOUND');
    expectSealError(() => sealer.open(row, []), 'SEAL_UNBOUND');
  });

  it('refuses a changed key id, even one that names another listed key', () => {
    const sealer = sealerOf(key('k1', 1), key('k2', 1));
    const row = sealer.seal(SECRET, BOUND);
    // Same material under both ids, so only the bound id can tell them apart.
    expectSealError(() => sealer.open({ ...row, keyId: 'k2' }, BOUND), 'SEAL_UNREADABLE');
  });

  it('refuses an unknown key id and a known id with other material', () => {
    const row = sealerOf(key('k1', 1)).seal(SECRET, BOUND);
    expectSealError(() => sealerOf(key('k2', 2)).open(row, BOUND), 'SEAL_UNREADABLE');
    expectSealError(() => sealerOf(key('k1', 9)).open(row, BOUND), 'SEAL_UNREADABLE');
  });

  it('refuses a value sealed under other labels, whichever label differs', () => {
    const row = sealerOf(key('k1', 1)).seal(SECRET, BOUND);
    for (const label of ['hkdfSalt', 'hkdfInfo', 'aadVersion'] as const) {
      const other = aesGcmSealer([key('k1', 1)], { ...LABELS, [label]: 'other' }, CONFIG_KEY);
      expectSealError(() => other.open(row, BOUND), 'SEAL_UNREADABLE');
    }
  });

  it('refuses a nonce or sealed value of the wrong length before decrypting', () => {
    const sealer = sealerOf(key('k1', 1));
    const row = sealer.seal(SECRET, BOUND);
    for (const bent of [
      { ...row, nonce: row.nonce.subarray(0, 11) },
      { ...row, nonce: Buffer.concat([row.nonce, Buffer.alloc(1)]) },
      { ...row, sealed: row.sealed.subarray(0, 15) },
      { ...row, sealed: row.sealed.subarray(0, 16) },
    ]) {
      expectSealError(() => sealer.open(bent, BOUND), 'SEAL_UNREADABLE');
    }
  });
});

describe('aesGcmSealer refuses a bad keyring', () => {
  const refused = (work: () => unknown, reason: string) => {
    const error = expectSealError(work, 'SEAL_CONFIG_INVALID');
    expect(error.configKey).toBe(CONFIG_KEY);
    expect(error.reason).toBe(reason);
    expect(error.message).toBe(`SEAL_CONFIG_INVALID: ${CONFIG_KEY} ${reason}`);
  };

  it('with no key or too many keys', () => {
    refused(() => sealerOf(), 'must list at least one key');
    const many = Array.from({ length: MAX_SEAL_KEYS + 1 }, (_, i) => key(`k${i}`, i));
    refused(() => sealerOf(...many), `must list at most ${MAX_SEAL_KEYS} keys`);
    expect(() => sealerOf(...many.slice(1))).not.toThrow();
  });

  it('with a short key, naming its position and never its id', () => {
    refused(
      () => sealerOf(key('k1', 1), key('k2', 1, 31)),
      'entry 2 must be at least 32 random bytes',
    );
  });

  it('with a bad id', () => {
    for (const id of ['', 'K1', 'k-1', 'abcdefghi', 'k 1']) {
      refused(
        () => sealerOf(key(id, 1)),
        'entry 1 needs an id of 1 to 8 lowercase letters or digits',
      );
    }
  });

  it('with a repeated id', () => {
    refused(
      () => sealerOf(key('k1', 1), key('k1', 2)),
      'entry 2 repeats the id of an earlier entry',
    );
  });

  it('with an empty label or config key name', () => {
    for (const label of ['hkdfSalt', 'hkdfInfo', 'aadVersion'] as const) {
      const error = expectSealError(
        () => aesGcmSealer([key('k1', 1)], { ...LABELS, [label]: '' }, CONFIG_KEY),
        'SEAL_CONFIG_INVALID',
      );
      expect(error.reason).toBe(`label ${label} must not be empty`);
    }
    expectSealError(() => aesGcmSealer([key('k1', 1)], LABELS, ''), 'SEAL_CONFIG_INVALID');
  });
});
