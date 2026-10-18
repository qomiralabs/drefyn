import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ID_KINDS, idOf, organizationId, projectId } from '../src/index.ts';
import { UUID_PATTERN, anyUuid, codeOf, runs } from './support.ts';

// Near misses of a valid UUID: one character swapped for anything, inserted or removed.
const nearUuid = fc.oneof(
  fc
    .tuple(anyUuid, fc.nat({ max: 35 }), fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }))
    .map(([u, i, c]) => u.slice(0, i) + c + u.slice(i + 1)),
  fc
    .tuple(anyUuid, fc.nat({ max: 36 }), fc.string({ unit: 'binary', minLength: 1, maxLength: 2 }))
    .map(([u, i, c]) => u.slice(0, i) + c + u.slice(i)),
  fc.tuple(anyUuid, fc.nat({ max: 35 })).map(([u, i]) => u.slice(0, i) + u.slice(i + 1)),
  anyUuid.map((u) => u.toUpperCase()),
);

describe('branding constructors (property)', () => {
  it('accept every canonical UUID unchanged, for every kind', () => {
    fc.assert(
      fc.property(anyUuid, fc.constantFrom(...ID_KINDS), (uuid, kind) => {
        expect(organizationId(uuid)).toBe(uuid);
        expect(projectId(uuid)).toBe(uuid);
        expect(idOf(kind, uuid)).toBe(uuid);
      }),
      runs,
    );
  });

  it('accept a string exactly when it is a canonical lowercase UUID', () => {
    fc.assert(
      fc.property(fc.oneof(nearUuid, fc.string({ unit: 'binary', maxLength: 40 })), (value) => {
        const expected = UUID_PATTERN.test(value) ? 'no error' : 'ID_MALFORMED';
        expect(codeOf(() => organizationId(value))).toBe(expected);
        expect(codeOf(() => projectId(value))).toBe(expected);
      }),
      runs,
    );
  });
});
