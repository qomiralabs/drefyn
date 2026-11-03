import { argon2 } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ARGON2_FLOOR, formatPhc, parsePhc, type Argon2Params } from '../src/index.ts';
import type { Argon2Function } from '../src/password-hash.ts';
import { SMALL, smallHasher } from './password-fixtures.ts';

const BIGGER: Argon2Params = { memoryKib: 128, passes: 2, parallelism: 1 };

const SALT = Buffer.alloc(16, 1);
const TAG = Buffer.alloc(32, 2);
const b64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');
const phcAt = (m: number, t: number, p: number, alg = 'argon2id', v = '19') =>
  `$${alg}$v=${v}$m=${String(m)},t=${String(t)},p=${String(p)}$${b64(SALT)}$${b64(TAG)}`;

describe('PHC strings', () => {
  it('format and parse round trip at the floor', () => {
    const phc = formatPhc(ARGON2_FLOOR, SALT, TAG);
    expect(phc).toBe(`$argon2id$v=19$m=19456,t=2,p=1$${b64(SALT)}$${b64(TAG)}`);
    const parsed = parsePhc(phc);
    expect(parsed?.params).toEqual(ARGON2_FLOOR);
    expect(parsed?.salt.equals(SALT)).toBe(true);
    expect(parsed?.tag.equals(TAG)).toBe(true);
  });

  it.each([
    ['argon2i', phcAt(19_456, 2, 1, 'argon2i')],
    ['argon2d', phcAt(19_456, 2, 1, 'argon2d')],
    ['scrypt', `$scrypt$ln=17,r=8,p=1$${b64(SALT)}$${b64(TAG)}`],
    ['bcrypt', '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW'],
    ['an old version', phcAt(19_456, 2, 1, 'argon2id', '16')],
    ['no version', `$argon2id$m=19456,t=2,p=1$${b64(SALT)}$${b64(TAG)}`],
    ['plain text', 'correct horse battery staple'],
    ['an empty string', ''],
  ])('refuses %s', (_name, phc) => {
    expect(parsePhc(phc)).toBeNull();
  });

  it.each([
    ['memory under the floor', phcAt(19_455, 2, 1)],
    ['passes under the floor', phcAt(19_456, 1, 1)],
    ['no parallelism', phcAt(19_456, 2, 0)],
    ['memory over the ceiling', phcAt(262_145, 2, 1)],
    ['passes over the ceiling', phcAt(19_456, 11, 1)],
    ['parallelism over the ceiling', phcAt(19_456, 2, 5)],
  ])('refuses %s', (_name, phc) => {
    expect(parsePhc(phc)).toBeNull();
  });

  it.each([
    ['parameters out of order', `$argon2id$v=19$t=2,m=19456,p=1$${b64(SALT)}$${b64(TAG)}`],
    ['a leading zero', phcAt(19_456, 2, 1).replace('t=2', 't=02')],
    ['padding', `$argon2id$v=19$m=19456,t=2,p=1$${SALT.toString('base64')}$${b64(TAG)}`],
    [
      'base64url',
      `$argon2id$v=19$m=19456,t=2,p=1$${b64(SALT)}$${b64(Buffer.alloc(32, 0xfb)).replace(/\+/g, '-')}`,
    ],
    ['a short salt', `$argon2id$v=19$m=19456,t=2,p=1$${b64(Buffer.alloc(7))}$${b64(TAG)}`],
    ['a short tag', `$argon2id$v=19$m=19456,t=2,p=1$${b64(SALT)}$${b64(Buffer.alloc(15))}`],
    ['trailing text', `${phcAt(19_456, 2, 1)}$x`],
    [
      'a non canonical last character',
      `$argon2id$v=19$m=19456,t=2,p=1$${b64(SALT).slice(0, -1)}B$${b64(TAG)}`,
    ],
  ])('refuses %s', (_name, phc) => {
    expect(parsePhc(phc)).toBeNull();
  });

  it('takes a lower floor only when one is passed, as the tests do', () => {
    expect(parsePhc(phcAt(64, 1, 1))).toBeNull();
    expect(parsePhc(phcAt(64, 1, 1), SMALL)?.params).toEqual(SMALL);
  });

  it('matches what node:crypto computes for the same inputs', async () => {
    const tag = await new Promise<Buffer>((resolve, reject) => {
      argon2(
        'argon2id',
        {
          message: 'a password',
          nonce: SALT,
          parallelism: 1,
          tagLength: 32,
          memory: 64,
          passes: 1,
        },
        (error, key) => (error === null ? resolve(key) : reject(error)),
      );
    });
    const hasher = smallHasher();
    await expect(hasher.verify(formatPhc(SMALL, SALT, tag), 'a password')).resolves.toBe(true);
    await expect(hasher.verify(formatPhc(SMALL, SALT, tag), 'a passworD')).resolves.toBe(false);
  });
});

describe('createPasswordHasher', () => {
  it('writes argon2id PHC strings at the configured parameters with a fresh 16 byte salt', async () => {
    const hasher = smallHasher();
    const a = await hasher.hash('the same password');
    const b = await hasher.hash('the same password');
    expect(a).not.toBe(b);
    const parsed = parsePhc(a, SMALL);
    expect(parsed?.params).toEqual(SMALL);
    expect(parsed?.salt).toHaveLength(16);
    expect(parsed?.tag).toHaveLength(32);
  });

  it('asks for a rehash exactly when the stored parameters differ from the configured ones', async () => {
    const old = await smallHasher().hash('a long enough password');
    const same = await smallHasher().check(old, 'a long enough password');
    expect(same).toEqual({ matched: true, rehash: false, readable: true });
    const raised = await smallHasher({ params: BIGGER }).check(old, 'a long enough password');
    expect(raised).toEqual({ matched: true, rehash: true, readable: true });
    const wrong = await smallHasher({ params: BIGGER }).check(old, 'another password here');
    expect(wrong).toEqual({ matched: false, rehash: false, readable: true });
  });

  it('runs a full verify against a dummy at the current parameters when there is no hash', async () => {
    const calls: number[] = [];
    const real: Argon2Function = (algorithm, parameters, callback) => {
      calls.push(parameters.memory);
      argon2(algorithm, parameters, callback);
    };
    const hasher = smallHasher({ argon2: real, params: BIGGER });
    await expect(hasher.check(null, 'a password')).resolves.toEqual({
      matched: false,
      rehash: false,
      readable: true,
    });
    // The dummy is made once, then each miss is one hash at the current parameters.
    await hasher.check(null, 'a password');
    expect(calls).toEqual([128, 128, 128]);
  });

  it('treats an unreadable stored hash as no hash, says so, and still pays for a verify', async () => {
    const argonCalls = vi.fn<Argon2Function>((a, p, c) => {
      argon2(a, p, c);
    });
    const hasher = smallHasher({ argon2: argonCalls });
    await expect(hasher.check('$2b$12$notours', 'a password')).resolves.toEqual({
      matched: false,
      rehash: false,
      readable: false,
    });
    expect(argonCalls).toHaveBeenCalled();
  });

  it('pads a miss against cheaper stored parameters up to the current cost', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    let fake = 0;
    const clock = () => fake;
    // Hashes at the current parameters take 20 ms on this clock, cheaper ones 5 ms.
    const timed: Argon2Function = (algorithm, parameters, callback) => {
      fake += parameters.memory === BIGGER.memoryKib ? 20 : 5;
      argon2(algorithm, parameters, callback);
    };
    const old = await smallHasher().hash('the real password');
    const hasher = smallHasher({ params: BIGGER, argon2: timed, sleep, clock });
    await hasher.check(null, 'warm the estimate');
    sleep.mockClear();
    await hasher.check(old, 'a wrong password');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBe(15);
    // A right password is not padded: the rehash that follows costs a full hash anyway.
    sleep.mockClear();
    await hasher.check(old, 'the real password');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('pays a dummy instead of padding when it has no estimate yet', async () => {
    const sleep = vi.fn((_ms: number) => Promise.resolve());
    const memories: number[] = [];
    const counting: Argon2Function = (algorithm, parameters, callback) => {
      memories.push(parameters.memory);
      argon2(algorithm, parameters, callback);
    };
    const old = await smallHasher().hash('the real password');
    const hasher = smallHasher({ params: BIGGER, argon2: counting, sleep });
    await hasher.check(old, 'a wrong password');
    // The stored verify, then the dummy made and verified at the current parameters.
    expect(memories).toEqual([64, 128, 128]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('turns a failing argon2 into AUTH_UNAVAILABLE without the password in it', async () => {
    const broken: Argon2Function = (_a, _p, callback) => {
      callback(new Error('argon2 failed'), Buffer.alloc(0));
    };
    const hasher = smallHasher({ argon2: broken });
    const error: unknown = await hasher.hash('a secret password value').catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'AUTH_UNAVAILABLE' });
    expect(String(error)).not.toContain('a secret password value');
  });

  it('an argon2 that throws instead of calling back is AUTH_UNAVAILABLE too', async () => {
    const throwing: Argon2Function = () => {
      throw new Error('not supported');
    };
    await expect(smallHasher({ argon2: throwing }).hash('a long enough one')).rejects.toMatchObject(
      {
        code: 'AUTH_UNAVAILABLE',
      },
    );
  });

  it('a dummy that failed to build is built again on the next miss', async () => {
    let fail = true;
    const flaky: Argon2Function = (a, p, callback) => {
      if (fail) {
        fail = false;
        callback(new Error('once'), Buffer.alloc(0));
        return;
      }
      argon2(a, p, callback);
    };
    const hasher = smallHasher({ argon2: flaky });
    await expect(hasher.check(null, 'x'.repeat(20))).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
    });
    await expect(hasher.check(null, 'x'.repeat(20))).resolves.toMatchObject({ matched: false });
  });

  it('refuses oversized input before hashing it', async () => {
    const argonCalls = vi.fn<Argon2Function>((a, p, c) => {
      argon2(a, p, c);
    });
    const hasher = smallHasher({ argon2: argonCalls });
    await expect(hasher.hash('a'.repeat(4097))).rejects.toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
    await expect(hasher.check(null, 'a'.repeat(1025))).rejects.toMatchObject({
      code: 'AUTH_INPUT_INVALID',
    });
    expect(argonCalls).not.toHaveBeenCalled();
  });

  it('salts come from the injected source when one is given', async () => {
    const hasher = smallHasher({ random: (n) => new Uint8Array(n).fill(3) });
    const parsed = parsePhc(await hasher.hash('a password of length'), SMALL);
    expect(parsed?.salt.equals(Buffer.alloc(16, 3))).toBe(true);
  });
});
