// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { Insertable, Selectable, Updateable } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  withAuth,
  type AuthDatabase,
  type AuthSchema,
  type OrganizationSchema,
  type TenantSchema,
  type UserSchema,
} from '../../src/index.ts';

declare const authDb: AuthDatabase;

async function compileOnly(): Promise<void> {
  await withAuth(authDb, async (tx) => {
    await tx.selectFrom('sso_connections').select(['id', 'oidc_client_id']).execute();
    // @ts-expect-error the sign in role never reads the sealed client secret
    await tx.selectFrom('sso_connections').select(['oidc_client_secret_sealed']).execute();
    // @ts-expect-error nor the domain proof
    await tx.selectFrom('sso_domains').select(['txt_token_hash']).execute();
    // @ts-expect-error an identity is linked, never moved
    await tx.updateTable('sso_identities').set({ user_id: 'x' }).execute();
    await tx.deleteFrom('sso_states').returning(['organization_id', 'nonce']).execute();
  });
}

describe('sso schema types', () => {
  it('give the sign in role the lookup columns of a connection only', () => {
    expectTypeOf<keyof Selectable<AuthSchema['sso_connections']>>().toEqualTypeOf<
      | 'id'
      | 'organization_id'
      | 'protocol'
      | 'status'
      | 'display_name'
      | 'oidc_issuer'
      | 'oidc_client_id'
      | 'oidc_endpoints'
      | 'saml_idp_entity_id'
      | 'saml_idp_sso_url'
      | 'saml_idp_certs'
      | 'jit_enabled'
      | 'jit_default_project_role'
      | 'session_max_seconds'
    >();
    expectTypeOf<keyof Insertable<AuthSchema['sso_connections']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Selectable<AuthSchema['sso_domains']>>().toEqualTypeOf<
      'domain' | 'organization_id' | 'connection_id' | 'verified_at'
    >();
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty is the point: nothing is updatable
    expectTypeOf<keyof Updateable<AuthSchema['sso_identities']>>().toEqualTypeOf<never>();
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty is the point: nothing is updatable
    expectTypeOf<keyof Updateable<AuthSchema['sso_states']>>().toEqualTypeOf<never>();
  });

  // An organization admin who could write an identity could sign in as anyone.
  it('let organization work read and remove an identity, never write one', () => {
    expectTypeOf<keyof Insertable<OrganizationSchema['sso_identities']>>().toEqualTypeOf<never>();
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty is the point: nothing is updatable
    expectTypeOf<keyof Updateable<OrganizationSchema['sso_identities']>>().toEqualTypeOf<never>();
    // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- empty is the point: nothing is updatable
    expectTypeOf<keyof Updateable<UserSchema['sso_identities']>>().toEqualTypeOf<never>();
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('sso_states');
  });

  it('keep a connection in place and a domain under its name', () => {
    expectTypeOf<
      keyof Updateable<OrganizationSchema['sso_connections']>
    >().not.toEqualTypeOf<never>();
    expectTypeOf<Updateable<OrganizationSchema['sso_connections']>>().not.toHaveProperty(
      'organization_id',
    );
    expectTypeOf<Updateable<OrganizationSchema['sso_connections']>>().not.toHaveProperty(
      'protocol',
    );
    expectTypeOf<Updateable<OrganizationSchema['sso_connections']>>().not.toHaveProperty(
      'idempotency_key',
    );
    expectTypeOf<Updateable<OrganizationSchema['sso_domains']>>().not.toHaveProperty('domain');
    expectTypeOf<Updateable<OrganizationSchema['organizations']>>().not.toHaveProperty(
      'sso_enforcement',
    );
  });

  it('keep SSO out of project work', () => {
    expectTypeOf<TenantSchema>().not.toHaveProperty('sso_connections');
    expectTypeOf<TenantSchema>().not.toHaveProperty('sso_domains');
    expectTypeOf<TenantSchema>().not.toHaveProperty('sso_identities');
    expectTypeOf<TenantSchema>().not.toHaveProperty('sso_states');
  });

  it('loads', () => {
    expect(compileOnly).toBeTypeOf('function');
  });
});
