import { createHash } from 'node:crypto';
import { userId } from '@drefyn/tenancy';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_COUNT,
  lengthPrefixed,
  matchRecoveryCode,
  newRecoveryCodes,
  recoveryCodeHash,
} from '../src/index.ts';
import { CROCKFORD, UUID_A, UUID_B } from './support.ts';

const ALICE = userId(UUID_A);
const BOB = userId(UUID_B);
const SHOWN =
  /^[0-9a-hjkmnp-tv-z]{6}-[0-9a-hjkmnp-tv-z]{6}-[0-9a-hjkmnp-tv-z]{6}-[0-9a-hjkmnp-tv-z]{6}$/;

describe('newRecoveryCodes', () => {
  it('makes ten distinct codes of 24 lowercase Crockford characters in four groups', () => {
    const codes = newRecoveryCodes(ALICE);
    expect(RECOVERY_CODE_COUNT).toBe(10);
    expect(codes).toHaveLength(10);
    for (const { code, hash } of codes) {
      expect(code).toMatch(SHOWN);
      for (const c of code.replaceAll('-', '')) expect(CROCKFORD).toContain(c);
      expect(hash).toHaveLength(32);
      expect(recoveryCodeHash(ALICE, code)?.equals(hash)).toBe(true);
    }
    expect(new Set(codes.map((c) => c.code)).size).toBe(10);
    expect(Object.isFrozen(codes)).toBe(true);
  });

  it('carries 120 random bits in each code', () => {
    // Every symbol of the alphabet turns up in every position across enough codes, which a
    // fixed or short source would not do.
    const positions = Array.from({ length: 24 }, () => new Set<string>());
    for (let i = 0; i < 200; i += 1) {
      for (const { code } of newRecoveryCodes(ALICE)) {
        Array.from(code.replaceAll('-', '')).forEach((c, at) => {
          positions[at]?.add(c);
        });
      }
    }
    for (const seen of positions) expect(seen.size).toBe(32);
  });
});

describe('recoveryCodeHash', () => {
  const code = newRecoveryCodes(ALICE)[0]?.code ?? '';
  const plain = code.replaceAll('-', '');

  it('is SHA-256 over a version label, the user id and the cleaned code', () => {
    const expected = createHash('sha256')
      .update(lengthPrefixed(['drefyn.recovery_code.v1', UUID_A, plain]))
      .digest();
    expect(recoveryCodeHash(ALICE, code)?.equals(expected)).toBe(true);
  });

  it('hashes the same code differently for two people', () => {
    const a = recoveryCodeHash(ALICE, code);
    const b = recoveryCodeHash(BOB, code);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.equals(b ?? Buffer.alloc(0))).toBe(false);
  });

  it('drops hyphens and typed gaps and ignores case', () => {
    const want = recoveryCodeHash(ALICE, code);
    for (const typed of [
      plain,
      plain.toUpperCase(),
      code.toUpperCase(),
      code.replaceAll('-', ' '),
      ` ${code} `,
      `${plain.slice(0, 4)} - ${plain.slice(4)}`,
      plain.split('').join('\t'),
    ]) {
      expect(recoveryCodeHash(ALICE, typed)?.equals(want ?? Buffer.alloc(0)), typed).toBe(true);
    }
  });

  it('refuses any other shape', () => {
    for (const typed of [
      '',
      plain.slice(1),
      `${plain}0`,
      // i, l, o and u are outside the alphabet.
      `${plain.slice(0, 23)}i`,
      `${plain.slice(0, 23)}l`,
      `${plain.slice(0, 23)}o`,
      `${plain.slice(0, 23)}u`,
      `${plain.slice(0, 23)}_`,
      `${plain.slice(0, 23)}а`,
      `${plain}\u0000`,
      '-'.repeat(10_000),
      // A six digit TOTP code is never mistaken for a recovery code.
      '123456',
    ]) {
      expect(recoveryCodeHash(ALICE, typed), typed.slice(0, 30)).toBeNull();
    }
  });
});

describe('matchRecoveryCode', () => {
  const issued = newRecoveryCodes(ALICE);
  const rows = issued.map((c, i) => ({ id: `row-${i}`, codeHash: c.hash }));

  it('answers the id of the matching row', () => {
    issued.forEach((c, i) => {
      expect(matchRecoveryCode(ALICE, c.code, rows)).toBe(`row-${i}`);
    });
  });

  it('refuses a code issued to someone else, a malformed one or an empty set', () => {
    const other = newRecoveryCodes(BOB)[0]?.code ?? '';
    expect(matchRecoveryCode(ALICE, other, rows)).toBeNull();
    // Alice's own code, checked against Bob's context, never matches her rows.
    expect(matchRecoveryCode(BOB, issued[0]?.code ?? '', rows)).toBeNull();
    expect(matchRecoveryCode(ALICE, 'not a code', rows)).toBeNull();
    expect(matchRecoveryCode(ALICE, issued[0]?.code ?? '', [])).toBeNull();
  });

  it('refuses more rows than a person can hold', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      id: `r${i}`,
      codeHash: Buffer.alloc(32),
    }));
    expect(() => matchRecoveryCode(ALICE, issued[0]?.code ?? '', many)).toThrow(
      expect.objectContaining({ code: 'AUTH_UNAVAILABLE' }),
    );
  });
});
