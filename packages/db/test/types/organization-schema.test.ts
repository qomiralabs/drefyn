// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { OrganizationRef, UserRef } from '@drefyn/tenancy';
import type { Insertable, Updateable } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  withOrganization,
  withUser,
  type Database,
  type OrganizationSchema,
  type TenantSchema,
  type UserSchema,
} from '../../src/index.ts';

declare const db: Database;
declare const user: UserRef;
declare const org: OrganizationRef;

async function compileOnly(): Promise<void> {
  await withUser(db, user, async (tx) => {
    // The person lists their organizations through their own memberships.
    await tx
      .selectFrom('memberships')
      .innerJoin('organizations', 'organizations.organization_id', 'memberships.organization_id')
      .innerJoin(
        'organization_slugs',
        'organization_slugs.organization_id',
        'memberships.organization_id',
      )
      .select(['organizations.name', 'organization_slugs.slug', 'memberships.role'])
      .execute();
    // @ts-expect-error a user context reads organizations, it never writes them
    await tx.insertInto('organizations').values({ name: 'x', plan_tier: 'free' }).execute();
    // @ts-expect-error nor renames one
    await tx.updateTable('organizations').set({ name: 'x' }).execute();
    // @ts-expect-error nor takes a slug
    await tx.insertInto('organization_slugs').values({ slug: 'x' }).execute();
    // @ts-expect-error nor changes its own role
    await tx.updateTable('memberships').set({ role: 'owner' }).execute();
    // @ts-expect-error projects are organization work, not the person's
    await tx.selectFrom('projects').selectAll().execute();
  });

  await withOrganization(db, org, async (tx) => {
    await tx
      .insertInto('organizations')
      .values({ organization_id: 'x', name: 'x', plan_tier: 'free' })
      .execute();
    await tx.insertInto('organization_slugs').values({ slug: 'x', organization_id: 'x' }).execute();
    await tx
      .insertInto('memberships')
      .values({ organization_id: 'x', user_id: 'x', role: 'owner' })
      .execute();
    await tx
      .insertInto('projects')
      .values({ organization_id: 'x', product: 'docs', slug: 'x', name: 'x' })
      .execute();
  });
}

describe('organization schema types', () => {
  it('give a user context the organization tables it reads', () => {
    expectTypeOf<keyof UserSchema>().toEqualTypeOf<
      | 'users'
      | 'identities'
      | 'sessions'
      | 'password_credentials'
      | 'memberships'
      | 'organizations'
      | 'organization_slugs'
    >();
  });

  it('leave nothing insertable or updatable in them under a user context', () => {
    expectTypeOf<keyof Insertable<UserSchema['organizations']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Updateable<UserSchema['organizations']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Insertable<UserSchema['organization_slugs']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Insertable<UserSchema['memberships']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Updateable<UserSchema['memberships']>>().toEqualTypeOf<never>();
  });

  it('give organization scope the four tables, writable', () => {
    expectTypeOf<OrganizationSchema>().toHaveProperty('organizations');
    expectTypeOf<OrganizationSchema>().toHaveProperty('organization_slugs');
    expectTypeOf<OrganizationSchema>().toHaveProperty('memberships');
    expectTypeOf<OrganizationSchema>().toHaveProperty('projects');
    expectTypeOf<TenantSchema>().toHaveProperty('projects');
  });

  it('loads', () => {
    expect(typeof compileOnly).toBe('function');
  });
});
