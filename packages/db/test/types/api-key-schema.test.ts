// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { OrganizationRef, TenantRef } from '@drefyn/tenancy';
import type { Updateable } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  withOrganization,
  withTenant,
  type Database,
  type OrganizationSchema,
  type TenantSchema,
} from '../../src/index.ts';

declare const db: Database;
declare const org: OrganizationRef;
declare const tenant: TenantRef;

async function compileOnly(): Promise<void> {
  await withOrganization(db, org, async (tx) => {
    await tx
      .insertInto('api_keys')
      .values({
        organization_id: 'x',
        name: 'x',
        secret_hash: Buffer.alloc(32),
        display_suffix: 'abcd',
        scopes: ['docs:read'],
        project_scope: 'listed',
        idempotency_key: 'x',
        request_hash: Buffer.alloc(32),
      })
      .execute();
    await tx
      .insertInto('api_key_projects')
      .values({ organization_id: 'x', api_key_id: 'x', target_project_id: 'x' })
      .execute();
    await tx.updateTable('api_keys').set({ last_used_at: new Date() }).execute();
    await tx.updateTable('api_keys').set({ revoked_at: new Date() }).execute();
    const hash = Buffer.alloc(32);
    const scopes = ['docs:read'];
    // @ts-expect-error a key's hash is set once
    await tx.updateTable('api_keys').set({ secret_hash: hash }).execute();
    // @ts-expect-error nor are its scopes widened
    await tx.updateTable('api_keys').set({ scopes }).execute();
    // @ts-expect-error nor its project reach
    await tx.updateTable('api_keys').set({ project_scope: 'all' }).execute();
    // @ts-expect-error a listed project is never repointed
    await tx.updateTable('api_key_projects').set({ target_project_id: 'x' }).execute();
  });

  await withTenant(db, tenant, async (tx) => {
    // @ts-expect-error project work never names key hashes
    await tx.selectFrom('api_keys').selectAll().execute();
    // @ts-expect-error nor the projects a key reaches
    await tx.selectFrom('api_key_projects').selectAll().execute();
  });
}

describe('API key schema types', () => {
  it('let organization scope update only the use and revoke times', () => {
    expectTypeOf<keyof Updateable<OrganizationSchema['api_keys']>>().toEqualTypeOf<
      'last_used_at' | 'revoked_at'
    >();
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty is the point: nothing is updatable
    expectTypeOf<keyof Updateable<OrganizationSchema['api_key_projects']>>().toEqualTypeOf<never>();
  });

  it('keep both tables out of project scope', () => {
    expectTypeOf<keyof TenantSchema & ('api_keys' | 'api_key_projects')>().toEqualTypeOf<never>();
  });

  it('loads', () => {
    expect(typeof compileOnly).toBe('function');
  });
});
