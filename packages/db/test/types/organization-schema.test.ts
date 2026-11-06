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
    // @ts-expect-error a user context reads organizations, it never renames one
    await tx.updateTable('organizations').set({ name: 'x' }).execute();
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
    await tx.updateTable('organizations').set({ name: 'x', updated_at: new Date() }).execute();
    await tx.updateTable('memberships').set({ default_project_role: 'viewer' }).execute();
    // @ts-expect-error organization work never sets its own plan
    await tx.updateTable('organizations').set({ plan_tier: 'enterprise' }).execute();
    // @ts-expect-error nor lifts its own read only state
    await tx.updateTable('organizations').set({ read_only_since: null }).execute();
    // A role changes in organization work, through the guarded path only.
    await tx.updateTable('memberships').set({ role: 'admin', updated_at: new Date() }).execute();
    // @ts-expect-error nor moves a membership to another person
    await tx.updateTable('memberships').set({ user_id: 'x' }).execute();
    await tx.updateTable('project_roles').set({ role: 'editor', updated_at: new Date() }).execute();
    // @ts-expect-error a project role is never repointed
    await tx.updateTable('project_roles').set({ target_project_id: 'x' }).execute();
    // @ts-expect-error nor a project's read only state
    await tx.updateTable('projects').set({ read_only_since: null }).execute();
    // @ts-expect-error history is append only
    await tx.updateTable('node_versions').set({ ast_version: 2 }).execute();
    await tx
      .updateTable('invitations')
      .set({ role: 'admin', send_count: 2, expires_at: new Date() })
      .execute();
    // @ts-expect-error an invitation never moves to another address
    await tx.updateTable('invitations').set({ email_normalized: 'x' }).execute();
    // @ts-expect-error nor to another organization
    await tx.updateTable('invitations').set({ organization_id: 'x' }).execute();
    await tx
      .insertInto('invitation_blocks')
      .values({ organization_id: 'x', email_hmac: Buffer.alloc(32) })
      .execute();
    const hmac = Buffer.alloc(32);
    // @ts-expect-error a block is never edited
    await tx.updateTable('invitation_blocks').set({ email_hmac: hmac }).execute();
    // @ts-expect-error nor is a membership moved to another invitation
    await tx.updateTable('memberships').set({ invitation_id: null }).execute();
  });
}

describe('organization schema types', () => {
  it('give a user context the organization tables it reads', () => {
    expectTypeOf<keyof UserSchema>().toEqualTypeOf<
      | 'users'
      | 'identities'
      | 'sessions'
      | 'password_credentials'
      | 'known_devices'
      | 'memberships'
      | 'organizations'
      | 'organization_slugs'
    >();
  });

  it('leave nothing insertable or updatable in them under a user context', () => {
    expectTypeOf<keyof Insertable<UserSchema['organizations']>>().toEqualTypeOf<never>();
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty is the point: nothing is updatable
    expectTypeOf<keyof Updateable<UserSchema['organizations']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Insertable<UserSchema['organization_slugs']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Insertable<UserSchema['memberships']>>().toEqualTypeOf<never>();
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty is the point: nothing is updatable
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
