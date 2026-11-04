import type { Result } from '@drefyn/address';
import { withAuth, withUser, type AuthDatabase, type Database } from '@drefyn/db';
import { sql } from 'kysely';
import { AuthError } from './errors.ts';
import { parseOAuthProvider, type OAuthProvider } from './oauth-types.ts';
import { parseOrganizationName } from './organization-rules.ts';
import type { AuthLogger } from './rate-limiter.ts';
import {
  fail,
  idFields,
  ok,
  quietInfo,
  type SessionInfo,
  type SessionStore,
} from './session-support.ts';

export interface LinkedIdentity {
  readonly provider: OAuthProvider;
  // The confirmed address the provider gave. Personal data, so never logged.
  readonly account: string;
  readonly linkedAt: Date;
}

// What a person may read about their own account.
export interface AccountView {
  readonly displayName: string | null;
  readonly email: string;
  readonly confirmedAt: Date | null;
  // Null when no password is set. The hash itself never leaves the sign in paths.
  readonly passwordSetAt: Date | null;
  readonly identities: readonly LinkedIdentity[];
}

export interface Account {
  readAccount(s: SessionInfo): Promise<Result<AccountView, AuthError>>;
  // Only the name: an address changes through proof of the new one.
  setDisplayName(
    s: SessionInfo,
    input: { readonly name: string },
  ): Promise<Result<{ readonly displayName: string }, AuthError>>;
}

export interface AccountDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: Pick<SessionStore, 'user' | 'auth'>;
  readonly logger: AuthLogger;
}

const SESSION_INVALID = () => new AuthError('AUTH_SESSION_INVALID');

export function createAccount(deps: AccountDeps): Account {
  const { db, authDb } = deps;
  const store: Pick<SessionStore, 'user' | 'auth'> | null =
    deps.store ??
    (db !== undefined && authDb !== undefined
      ? {
          user: (userId, work) => withUser(db, { userId }, work),
          auth: (work) => withAuth(authDb, work),
        }
      : null);
  if (store === null) throw new AuthError('AUTH_CONFIG_INVALID');

  return Object.freeze({
    async readAccount(s) {
      try {
        const read = await store.user(s.userId, async (tx) => {
          const user = await tx
            .selectFrom('users')
            .select(['email', 'display_name'])
            .where('id', '=', sql<string>`app.current_user_id()`)
            .executeTakeFirst();
          const password = await tx
            .selectFrom('password_credentials')
            .select('updated_at')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .executeTakeFirst();
          const identities = await tx
            .selectFrom('identities')
            .select(['provider', 'provider_email_normalized', 'created_at'])
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .orderBy('provider')
            .execute();
          return { user, password, identities };
        });
        if (read.user === undefined) return fail(SESSION_INVALID());
        // Only the auth role reads this column; the person's own context cannot.
        const confirmed = await store.auth((tx) =>
          tx
            .selectFrom('users')
            .select('email_verified_at')
            .where('id', '=', s.userId)
            .executeTakeFirst(),
        );
        return ok(
          Object.freeze({
            displayName: read.user.display_name,
            email: read.user.email,
            confirmedAt: confirmed?.email_verified_at ?? null,
            passwordSetAt: read.password?.updated_at ?? null,
            identities: Object.freeze(
              read.identities.flatMap((row) => {
                const provider = parseOAuthProvider(row.provider);
                if (provider === null) return [];
                return [
                  {
                    provider,
                    account: row.provider_email_normalized,
                    linkedAt: row.created_at,
                  },
                ];
              }),
            ),
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },

    async setDisplayName(s, input) {
      const name = parseOrganizationName(input.name);
      if (!name.ok) return name;
      try {
        const row = await store.user(s.userId, (tx) =>
          tx
            .updateTable('users')
            .set({ display_name: name.value, updated_at: sql<Date>`now()` })
            .where('id', '=', s.userId)
            .returning('display_name')
            .executeTakeFirst(),
        );
        if (row === undefined) return fail(SESSION_INVALID());
        quietInfo(
          deps.logger,
          'auth.display_name_changed',
          idFields({ userId: ['usr', s.userId] }),
        );
        return ok(Object.freeze({ displayName: name.value }));
      } catch (error) {
        return fail(error);
      }
    },
  } satisfies Account);
}
