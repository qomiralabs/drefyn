// Checked by `pnpm typecheck`: each @ts-expect-error fails the build if the line below it
// starts to compile. The function body never runs; vitest only confirms the file loads.
import type { UserRef } from '@drefyn/tenancy';
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  withApiKeyLimiter,
  withAuth,
  withUser,
  type ApiKeyLimiterSchema,
  type AuthDatabase,
  type AuthSchema,
  type Database,
  type OrganizationSchema,
  type UserSchema,
} from '../../src/index.ts';

declare const db: Database;
declare const authDb: AuthDatabase;
declare const user: UserRef;

async function compileOnly(): Promise<void> {
  await withUser(db, user, async (tx) => {
    await tx.selectFrom('users').select(['id', 'email', 'display_name', 'created_at']).execute();
    // @ts-expect-error drefyn_app holds no select on email_verified_at
    await tx.selectFrom('users').select('email_verified_at').execute();
    // @ts-expect-error nor on email_normalized
    await tx.selectFrom('users').select('email_normalized').execute();
    await tx.updateTable('users').set({ display_name: 'x', updated_at: new Date() }).execute();
    // @ts-expect-error drefyn_app may not write the address
    await tx.updateTable('users').set({ email: 'x@example.com' }).execute();
    // @ts-expect-error nor insert a user at all
    await tx.insertInto('users').values({ id: 'x' }).execute();
    await tx
      .insertInto('password_credentials')
      .values({ user_id: 'x', phc: '$argon2id$' })
      .execute();
    await tx
      .insertInto('password_credentials')
      // @ts-expect-error created_at is the database's to set
      .values({ user_id: 'x', phc: '$argon2id$', created_at: new Date() })
      .execute();
    // @ts-expect-error the sign in tables are not the person's
    await tx.selectFrom('email_challenges').selectAll().execute();
    // @ts-expect-error nor the API limiter
    await tx.selectFrom('api_key_failures').selectAll().execute();
  });

  await withAuth(authDb, async (tx) => {
    await tx.selectFrom('users').select(['id', 'email_normalized', 'email_verified_at']).execute();
    await tx
      .updateTable('users')
      .set({ email: 'x', email_normalized: 'x', email_verified_at: new Date() })
      .execute();
    // @ts-expect-error drefyn_auth may not rename anyone
    await tx.updateTable('users').set({ display_name: 'x' }).execute();
    await tx.selectFrom('password_credentials').select(['user_id', 'phc']).execute();
    // @ts-expect-error drefyn_auth only rehashes; it never creates a credential
    await tx.insertInto('password_credentials').values({ user_id: 'x', phc: 'x' }).execute();
    // @ts-expect-error sessions are written after sign in, never by the sign in role
    await tx.selectFrom('sessions').selectAll().execute();
    // @ts-expect-error the API limiter belongs to the API service
    await tx.selectFrom('api_key_failures').selectAll().execute();
  });

  await withApiKeyLimiter(db, async (tx) => {
    await tx.selectFrom('api_key_failures').select(['key_hmac', 'count']).execute();
    // @ts-expect-error the limiter context names one table
    await tx.selectFrom('users').select('id').execute();
  });
  // @ts-expect-error the limiter runs on the app pool, never the auth pool
  await withApiKeyLimiter(authDb, () => Promise.resolve(1));
}

describe('identity schema types', () => {
  it('give each context exactly its tables', () => {
    expectTypeOf<keyof ApiKeyLimiterSchema>().toEqualTypeOf<'api_key_failures'>();
    expectTypeOf<keyof AuthSchema>().toEqualTypeOf<
      | 'users'
      | 'identities'
      | 'password_credentials'
      | 'email_challenges'
      | 'oauth_states'
      | 'auth_rate_limits'
    >();
    expectTypeOf<keyof UserSchema>().toEqualTypeOf<
      'users' | 'identities' | 'sessions' | 'password_credentials'
    >();
    expectTypeOf<keyof UserSchema['users']>().toEqualTypeOf<
      'id' | 'email' | 'display_name' | 'created_at' | 'updated_at'
    >();
  });

  it('keep organization scope away from every identity table but users', () => {
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('sessions');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('email_challenges');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('api_key_failures');
    expectTypeOf<OrganizationSchema>().not.toHaveProperty('password_credentials');
    expectTypeOf<OrganizationSchema['users']>().toEqualTypeOf<UserSchema['users']>();
  });

  it('loads', () => {
    expect(typeof compileOnly).toBe('function');
  });
});
