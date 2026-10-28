import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Product } from '@drefyn/entitlements';
import {
  ORG_ROLES,
  PERMISSIONS,
  PROJECT_ROLES,
  canAssign,
  permissionsFor,
  type OrgRole,
} from '../src/permissions.ts';
import * as main from '../src/index.ts';
import { runs } from './support.ts';

const PRODUCTS: readonly Product[] = ['docs', 'studio', 'status'];
const role = fc.constantFrom(...ORG_ROLES);
const reach = fc.subarray([...PRODUCTS]).map((p) => new Set<Product>(p));

const rank = (r: OrgRole) => ORG_ROLES.length - 1 - ORG_ROLES.indexOf(r);

describe('roles', () => {
  it('lists organization roles from most to least powerful, and the project roles', () => {
    expect(ORG_ROLES).toEqual(['owner', 'admin', 'member']);
    expect(PROJECT_ROLES).toEqual(['admin', 'editor', 'viewer']);
    expect(Object.isFrozen(ORG_ROLES)).toBe(true);
    expect(Object.isFrozen(PROJECT_ROLES)).toBe(true);
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });
});

describe('permissionsFor', () => {
  it('is monotone: owner includes admin includes member, for any product reach', () => {
    fc.assert(
      fc.property(role, role, reach, (a, b, products) => {
        if (rank(a) < rank(b)) return;
        const strong = new Set(permissionsFor(a, products));
        for (const p of permissionsFor(b, products)) expect(strong.has(p)).toBe(true);
      }),
      runs,
    );
  });

  it('is monotone in product reach', () => {
    fc.assert(
      fc.property(role, reach, reach, (r, x, y) => {
        const union = new Set([...x, ...y]);
        const wide = new Set(permissionsFor(r, union));
        for (const p of permissionsFor(r, x)) expect(wide.has(p)).toBe(true);
      }),
      runs,
    );
  });

  it('grants a product read only for a product in reach', () => {
    fc.assert(
      fc.property(role, reach, (r, products) => {
        const granted = permissionsFor(r, products);
        for (const product of PRODUCTS) {
          expect(granted.includes(`${product}.read`)).toBe(products.has(product));
        }
      }),
      runs,
    );
  });

  it('gives each role exactly its organization permissions', () => {
    const none = new Set<Product>();
    expect(permissionsFor('member', none)).toEqual(['org.read']);
    expect(permissionsFor('admin', none)).toEqual([
      'org.read',
      'org.manage_members',
      'org.manage_api_keys',
      'org.manage_settings',
      'project.create',
    ]);
    expect(permissionsFor('owner', new Set(PRODUCTS))).toEqual([...PERMISSIONS]);
  });

  it('keeps billing and deletion to owners', () => {
    fc.assert(
      fc.property(role, reach, (r, products) => {
        const granted = permissionsFor(r, products);
        expect(granted.includes('org.manage_billing')).toBe(r === 'owner');
        expect(granted.includes('org.delete')).toBe(r === 'owner');
      }),
      runs,
    );
  });

  it('returns a frozen list in the order of PERMISSIONS, without duplicates', () => {
    fc.assert(
      fc.property(role, reach, (r, products) => {
        const granted = permissionsFor(r, products);
        expect(Object.isFrozen(granted)).toBe(true);
        expect(new Set(granted).size).toBe(granted.length);
        const order = granted.map((p) => PERMISSIONS.indexOf(p));
        expect(order).toEqual([...order].sort((x, y) => x - y));
      }),
      runs,
    );
  });

  it('refuses an unknown role or product rather than guessing', () => {
    expect(() => permissionsFor('guest' as OrgRole, new Set())).toThrow(TypeError);
    expect(() => permissionsFor('member', new Set(['website' as Product]))).toThrow(TypeError);
  });
});

describe('canAssign', () => {
  it('lets only owners assign owner', () => {
    fc.assert(
      fc.property(role, (actor) => {
        expect(canAssign(actor, 'owner')).toBe(actor === 'owner');
      }),
      runs,
    );
  });

  it('lets owners assign anything, admins assign admin and member, and members nothing', () => {
    const table = ORG_ROLES.map((actor) => ORG_ROLES.map((target) => canAssign(actor, target)));
    expect(table).toEqual([
      [true, true, true],
      [false, true, true],
      [false, false, false],
    ]);
  });

  it('never lets anyone assign a role above their own', () => {
    fc.assert(
      fc.property(role, role, (actor, target) => {
        if (canAssign(actor, target)) expect(rank(actor)).toBeGreaterThanOrEqual(rank(target));
      }),
      runs,
    );
  });

  it('refuses unknown roles', () => {
    expect(canAssign('root' as OrgRole, 'member')).toBe(false);
    expect(canAssign('owner', 'root' as OrgRole)).toBe(false);
  });
});

describe('the server entry', () => {
  it('re-exports the permission model unchanged', () => {
    expect(main.permissionsFor).toBe(permissionsFor);
    expect(main.canAssign).toBe(canAssign);
    expect(main.ORG_ROLES).toBe(ORG_ROLES);
    expect(main.PROJECT_ROLES).toBe(PROJECT_ROLES);
  });
});
