import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ORG_ROLES, canChangeRole, canRemove, type OrgRole } from '../src/permissions.ts';
import { removalRefusal, roleChangeRefusal } from '../src/role-rules.ts';
import { runs } from './support.ts';

const role = fc.constantFrom(...ORG_ROLES);
const self = fc.boolean();
// Higher is stronger.
const rank = (r: OrgRole) => ORG_ROLES.length - 1 - ORG_ROLES.indexOf(r);

describe('canChangeRole', () => {
  it('never lets an admin make, unmake or touch an owner', () => {
    fc.assert(
      fc.property(self, role, role, (s, from, to) => {
        if (from === 'owner' || to === 'owner') {
          expect(canChangeRole({ role: 'admin', self: s }, from, to)).toBe(false);
        }
      }),
      runs,
    );
  });

  it('never lets anyone raise their own role', () => {
    fc.assert(
      fc.property(role, role, role, (actor, from, to) => {
        if (rank(to) > rank(from))
          expect(canChangeRole({ role: actor, self: true }, from, to)).toBe(false);
      }),
      runs,
    );
  });

  it('never lets a member change anything', () => {
    fc.assert(
      fc.property(self, role, role, (s, from, to) => {
        expect(canChangeRole({ role: 'member', self: s }, from, to)).toBe(false);
      }),
      runs,
    );
  });

  it('lets an owner set any role on anyone else, and lower their own', () => {
    fc.assert(
      fc.property(self, role, role, (s, from, to) => {
        const allowed = !s || rank(to) <= rank(from);
        expect(canChangeRole({ role: 'owner', self: s }, from, to)).toBe(allowed);
      }),
      runs,
    );
  });

  it('lets an admin move admins and members between the two, and lower themselves', () => {
    for (const from of ['admin', 'member'] as const) {
      for (const to of ['admin', 'member'] as const) {
        expect(canChangeRole({ role: 'admin', self: false }, from, to), `${from} to ${to}`).toBe(
          true,
        );
      }
    }
    expect(canChangeRole({ role: 'admin', self: true }, 'admin', 'member')).toBe(true);
    expect(canChangeRole({ role: 'admin', self: true }, 'member', 'admin')).toBe(false);
  });

  it('refuses an unknown role on any side', () => {
    const odd = 'superuser' as OrgRole;
    expect(canChangeRole({ role: odd, self: false }, 'member', 'admin')).toBe(false);
    expect(canChangeRole({ role: 'owner', self: false }, odd, 'admin')).toBe(false);
    expect(canChangeRole({ role: 'owner', self: false }, 'member', odd)).toBe(false);
  });
});

describe('canRemove', () => {
  it('lets owners remove anyone else, admins remove admins and members, and members nobody', () => {
    const table = ORG_ROLES.map((actor) =>
      ORG_ROLES.map((target) => canRemove({ role: actor, self: false }, target)),
    );
    expect(table).toEqual([
      [true, true, true],
      [false, true, true],
      [false, false, false],
    ]);
  });

  // Leaving an organization is its own flow, not a removal.
  it('never removes the person acting', () => {
    fc.assert(
      fc.property(role, role, (actor, target) => {
        expect(canRemove({ role: actor, self: true }, target)).toBe(false);
      }),
      runs,
    );
  });

  it('refuses an unknown role', () => {
    expect(canRemove({ role: 'superuser' as OrgRole, self: false }, 'member')).toBe(false);
    expect(canRemove({ role: 'owner', self: false }, 'superuser' as OrgRole)).toBe(false);
  });
});

// A model organization run through the same decisions the code makes under its lock.
type Op =
  | {
      readonly kind: 'change';
      readonly actor: number;
      readonly target: number;
      readonly to: OrgRole;
    }
  | { readonly kind: 'remove'; readonly actor: number; readonly target: number };

const people = fc
  .tuple(
    fc.integer({ min: 1, max: 5 }),
    fc.array(fc.constantFrom<OrgRole>('admin', 'member'), { maxLength: 5 }),
  )
  .map(([owners, rest]) => [...Array.from({ length: owners }, (): OrgRole => 'owner'), ...rest]);
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('change' as const),
    actor: fc.nat({ max: 9 }),
    target: fc.nat({ max: 9 }),
    to: role,
  }),
  fc.record({
    kind: fc.constant('remove' as const),
    actor: fc.nat({ max: 9 }),
    target: fc.nat({ max: 9 }),
  }),
);

describe('any sequence of role changes and removals', () => {
  it('leaves at least one owner, never lets an admin reach an owner, and never raises the actor', () => {
    fc.assert(
      fc.property(people, fc.array(op, { maxLength: 40 }), (start, ops) => {
        const members = new Map(start.map((r, i) => [i, r]));
        for (const o of ops) {
          const actorRole = members.get(o.actor);
          const target = members.get(o.target);
          if (actorRole === undefined || target === undefined) continue;
          const others = [...members].filter(([i, r]) => i !== o.target && r === 'owner').length;
          const facts = { actorRole, self: o.actor === o.target, otherOwners: others };
          if (o.kind === 'change') {
            const refusal = roleChangeRefusal({ ...facts, from: target, to: o.to });
            if (refusal !== null) continue;
            if (actorRole === 'admin') {
              expect(target).not.toBe('owner');
              expect(o.to).not.toBe('owner');
            }
            if (facts.self) expect(rank(o.to)).toBeLessThanOrEqual(rank(target));
            members.set(o.target, o.to);
          } else {
            if (removalRefusal({ ...facts, target }) !== null) continue;
            if (actorRole === 'admin') expect(target).not.toBe('owner');
            members.delete(o.target);
          }
          expect([...members.values()].filter((r) => r === 'owner').length).toBeGreaterThan(0);
        }
      }),
      runs,
    );
  });

  it('answers AUTH_LAST_OWNER only to someone allowed to make the change', () => {
    expect(
      roleChangeRefusal({
        actorRole: 'owner',
        self: true,
        from: 'owner',
        to: 'admin',
        otherOwners: 0,
      }),
    ).toBe('AUTH_LAST_OWNER');
    expect(
      roleChangeRefusal({
        actorRole: 'admin',
        self: false,
        from: 'owner',
        to: 'admin',
        otherOwners: 0,
      }),
    ).toBe('AUTH_FORBIDDEN');
    expect(
      roleChangeRefusal({
        actorRole: 'owner',
        self: true,
        from: 'owner',
        to: 'admin',
        otherOwners: 1,
      }),
    ).toBeNull();
    expect(
      removalRefusal({ actorRole: 'owner', self: false, target: 'owner', otherOwners: 0 }),
    ).toBe('AUTH_LAST_OWNER');
    expect(
      removalRefusal({ actorRole: 'owner', self: false, target: 'owner', otherOwners: 1 }),
    ).toBeNull();
    expect(
      removalRefusal({ actorRole: 'admin', self: false, target: 'owner', otherOwners: 3 }),
    ).toBe('AUTH_FORBIDDEN');
  });
});
