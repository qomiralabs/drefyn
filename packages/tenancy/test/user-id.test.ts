import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { TenancyError, idOf, organizationId, userId, type UserRef } from '../src/index.ts';
import {
  MAX_UUID,
  NIL_UUID,
  NOT_UUIDS,
  V4,
  V7,
  anyUuid,
  codeOf,
  expectCode,
  runs,
} from './support.ts';

describe('userId', () => {
  it.each([
    ['UUIDv7', V7],
    ['UUIDv4', V4],
    ['nil', NIL_UUID],
    ['max', MAX_UUID],
  ])('accepts a canonical %s and returns it unchanged, like organizationId', (_label, value) => {
    expect(userId(value)).toBe(value);
    expect(userId(value)).toBe(organizationId(value));
  });

  it.each(NOT_UUIDS)('refuses %s with the same code as organizationId', (_label, value) => {
    expectCode(() => userId(value as string), 'ID_MALFORMED');
    expect(codeOf(() => userId(value as string))).toBe(
      codeOf(() => organizationId(value as string)),
    );
  });

  it('agrees with idOf for the usr kind', () => {
    expect(userId(V7)).toBe(idOf('usr', V7));
  });

  it('throws a TenancyError that does not echo the input', () => {
    const hostile = `x\n${'<script>'.repeat(64)}`;
    let caught: unknown;
    try {
      userId(hostile);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TenancyError);
    expect((caught as TenancyError).message).not.toContain('<script>');
  });

  it('rejects a megabyte of input without hanging', () => {
    expectCode(() => userId('0'.repeat(1_000_000)), 'ID_MALFORMED');
  });

  it('builds a UserRef that carries only the user', () => {
    const ref: UserRef = { userId: userId(V7) };
    expect(Object.keys(ref)).toEqual(['userId']);
  });
});

describe('userId (property)', () => {
  it('accepts every canonical UUID', () => {
    fc.assert(
      fc.property(anyUuid, (uuid) => {
        expect(userId(uuid)).toBe(uuid);
      }),
      runs,
    );
  });

  it('accepts and refuses exactly what organizationId does, with the same code', () => {
    const input = fc.oneof(
      anyUuid,
      anyUuid.map((u) => u.toUpperCase()),
      fc.string({
        unit: fc.constantFrom(...Array.from('0123456789abcdefABCDEFg-')),
        maxLength: 40,
      }),
      fc.string({ maxLength: 40 }),
    );
    fc.assert(
      fc.property(input, (value) => {
        const expected = codeOf(() => organizationId(value));
        expect(codeOf(() => userId(value))).toBe(expected);
        if (expected === 'no error') expect(userId(value)).toBe(organizationId(value));
      }),
      runs,
    );
  });
});
