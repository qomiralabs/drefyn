// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { UserRef } from '@drefyn/tenancy';
import type { Insertable, Transaction, Updateable } from 'kysely';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  withApiKeyLimiter,
  withAuth,
  withTenant,
  withUser,
  type ApiKeyLimiterSchema,
  type AuthDatabase,
  type AuthSchema,
  type Database,
  type OrganizationSchema,
  type TenantSchema,
  type UserSchema,
} from '../../src/index.ts';
import type { TenantRef } from '@drefyn/tenancy';

declare const db: Database;
declare const authDb: AuthDatabase;
declare const user: UserRef;
declare const tenant: TenantRef;

async function compileOnly(): Promise<void> {
  // Project work can name no identity or limiter table: a tenant path with an attacker
  // supplied organization must not reach the API key throttle or anyone's address.
  await withTenant(db, tenant, async (tx) => {
    // @ts-expect-error api_key_failures is the limiter's alone
    await tx.insertInto('api_key_failures').values({}).execute();
    // @ts-expect-error users is not a project table
    tx.selectFrom('users');
    // @ts-expect-error nor are the sign in tables
    tx.selectFrom('auth_rate_limits');
  });

  await withUser(db, user, async (tx) => {
    await tx.selectFrom('users').select(['id', 'email', 'display_name', 'created_at']).execute();
    // @ts-expect-error drefyn_app holds no select on email_verified_at
    await tx.selectFrom('users').select('email_verified_at').execute();
    // @ts-expect-error nor on email_normalized
    await tx.selectFrom('users').select('email_normalized').execute();
    await tx.updateTable('users').set({ display_name: 'x', updated_at: new Date() }).execute();
    // @ts-expect-error drefyn_app may not write the address
    await tx.updateTable('users').set({ email: 'x@example.com' }).execute();
    await tx
      .insertInto('password_credentials')
      .values({ user_id: 'x', phc: '$argon2id$' })
      .execute();
    await tx
      .insertInto('password_credentials')
      // @ts-expect-error created_at is the database's to set
      .values({ user_id: 'x', phc: '$argon2id$', created_at: new Date() })
      .execute();
    await tx.updateTable('factor_challenges').set({ attempts: 1 }).execute();
    await tx
      .updateTable('factor_challenges')
      // @ts-expect-error a challenge is replaced by delete then insert, never rewritten
      .set({ secret_hash: Buffer.alloc(32) })
      .execute();
    await tx.updateTable('recovery_codes').set({ used_at: new Date() }).execute();
    // @ts-expect-error a recovery code never moves to another person
    await tx.updateTable('recovery_codes').set({ user_id: 'x' }).execute();
    // @ts-expect-error nor does a credential
    await tx.updateTable('totp_credentials').set({ user_id: 'x' }).execute();
    // @ts-expect-error the sign in tables are not the person's
    await tx.selectFrom('email_challenges').selectAll().execute();
    // @ts-expect-error nor the API limiter
    await tx.selectFrom('api_key_failures').selectAll().execute();
  });

  await withAuth(authDb, async (tx) => {
    await tx.deleteFrom('api_keys').execute();
    // @ts-expect-error the auth role finds a key by revoked_at and reads nothing else
    await tx.selectFrom('api_keys').select('secret_hash').execute();
    // @ts-expect-error nor can it un-revoke one
    await tx.updateTable('api_keys').set({ revoked_at: null }).execute();
    await tx.selectFrom('users').select(['id', 'email_normalized', 'email_verified_at']).execute();
    await tx
      .updateTable('users')
      .set({ email: 'x', email_normalized: 'x', email_verified_at: new Date() })
      .execute();
    // @ts-expect-error drefyn_auth may not rename anyone
    await tx.updateTable('users').set({ display_name: 'x' }).execute();
    await tx.selectFrom('password_credentials').select(['user_id', 'phc']).execute();
    // @ts-expect-error sessions are written after sign in, never by the sign in role
    await tx.selectFrom('sessions').selectAll().execute();
    // @ts-expect-error the sign in role reads no sealed secret
    tx.selectFrom('totp_credentials');
    // @ts-expect-error nor a recovery hash
    tx.selectFrom('recovery_codes');
    // @ts-expect-error nor a half finished sign in
    tx.selectFrom('factor_challenges');
    // @ts-expect-error the API limiter belongs to the API service
    await tx.selectFrom('api_key_failures').selectAll().execute();
  });

  await withApiKeyLimiter(db, async (tx) => {
    await tx.selectFrom('api_key_failures').select(['key_hmac', 'count']).execute();
  });
}

describe('identity schema types', () => {
  it('run the limiter on the app pool only', () => {
    expectTypeOf(withApiKeyLimiter<number>)
      .parameter(0)
      .toEqualTypeOf<Database>();
  });

  it('give each context exactly its tables', () => {
    expectTypeOf<keyof ApiKeyLimiterSchema>().toEqualTypeOf<'api_key_failures'>();
    expectTypeOf<keyof AuthSchema>().toEqualTypeOf<
      | 'users'
      | 'identities'
      | 'password_credentials'
      | 'email_challenges'
      | 'oauth_states'
      | 'cli_sign_in_links'
      | 'auth_rate_limits'
      | 'known_devices'
      | 'scheduled_jobs'
      | 'api_keys'
    >();
    expectTypeOf<keyof UserSchema>().toEqualTypeOf<
      | 'users'
      | 'identities'
      | 'sessions'
      | 'password_credentials'
      | 'known_devices'
      | 'totp_credentials'
      | 'recovery_codes'
      | 'factor_challenges'
      | 'memberships'
      | 'organizations'
      | 'organization_slugs'
    >();
    expectTypeOf<keyof UserSchema['users']>().toEqualTypeOf<
      'id' | 'email' | 'display_name' | 'created_at' | 'updated_at'
    >();
  });

  it('let a person update only the listed second factor columns', () => {
    expectTypeOf<keyof Updateable<UserSchema['factor_challenges']>>().toEqualTypeOf<'attempts'>();
    expectTypeOf<keyof Updateable<UserSchema['recovery_codes']>>().toEqualTypeOf<'used_at'>();
    expectTypeOf<keyof Updateable<UserSchema['totp_credentials']>>().toEqualTypeOf<
      | 'key_id'
      | 'secret_nonce'
      | 'secret_sealed'
      | 'last_used_step'
      | 'failed_attempts'
      | 'confirmed_at'
      | 'last_used_at'
      | 'updated_at'
    >();
  });

  it('leave no insertable column where the role holds no insert', () => {
    expectTypeOf<keyof Insertable<UserSchema['users']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Insertable<AuthSchema['password_credentials']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Insertable<AuthSchema['users']>>().toEqualTypeOf<
      'id' | 'email' | 'email_normalized' | 'display_name' | 'email_verified_at'
    >();
    expectTypeOf<keyof Updateable<AuthSchema['users']>>().toEqualTypeOf<
      'email' | 'email_normalized' | 'email_verified_at' | 'updated_at'
    >();
  });

  it('let the auth role see only whether a device is known and when it was last seen', () => {
    expectTypeOf<keyof AuthSchema['known_devices']>().toEqualTypeOf<
      'user_id' | 'device_hash' | 'last_seen_at'
    >();
    expectTypeOf<keyof Insertable<AuthSchema['known_devices']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof AuthSchema['api_keys']>().toEqualTypeOf<'revoked_at' | 'organization_id'>();
    expectTypeOf<keyof Insertable<AuthSchema['api_keys']>>().toEqualTypeOf<never>();
    expectTypeOf<keyof Insertable<UserSchema['known_devices']>>().toEqualTypeOf<
      'user_id' | 'device_hash' | 'user_agent_family'
    >();
  });

  it('give project scope none of the identity or limiter tables', () => {
    expectTypeOf(withTenant<number>)
      .parameter(2)
      .parameter(0)
      .toEqualTypeOf<Transaction<TenantSchema>>();
    expectTypeOf<TenantSchema>().not.toHaveProperty('users');
    expectTypeOf<TenantSchema>().not.toHaveProperty('api_key_failures');
    expectTypeOf<TenantSchema>().not.toHaveProperty('sessions');
    expectTypeOf<TenantSchema>().not.toHaveProperty('auth_rate_limits');
  });

  it('keep organization scope away from every identity table but users', () => {
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('sessions');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('email_challenges');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('api_key_failures');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('password_credentials');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('known_devices');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('totp_credentials');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('recovery_codes');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('factor_challenges');
    expectTypeOf<TenantSchema>().not.toHaveProperty('totp_credentials');
    expectTypeOf<OrganizationSchema['users']>().toEqualTypeOf<UserSchema['users']>();
  });

  it('loads', () => {
    expect(typeof compileOnly).toBe('function');
  });
});
