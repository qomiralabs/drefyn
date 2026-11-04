import type { Result } from '@drefyn/address';
import { withAuth, withUser, type AuthDatabase, type Database } from '@drefyn/db';
import { idOf, type UserId } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { normalizeAddress } from './address.ts';
import { forgetDevices } from './devices.ts';
import { AuthError } from './errors.ts';
import type { AuthLogger } from './rate-limiter.ts';
import {
  fail,
  idFields,
  ok,
  quietInfo,
  unavailable,
  type SessionStore,
} from './session-support.ts';

// drefyn auth revoke-sessions. The auth role only finds people; every delete runs under
// that person's own user context, so the role that reads addresses never touches sessions.

export interface OperatorSessionsDeps {
  readonly db: Database;
  readonly authDb: AuthDatabase;
  readonly logger: AuthLogger;
  readonly store?: SessionStore;
}

export interface OperatorSessions {
  // AUTH_INPUT_INVALID for an address the rules refuse, AUTH_NOT_FOUND for one with no account.
  revokeForEmail(email: string): Promise<Result<number, AuthError>>;
  revokeAll(): Promise<number>;
}

const PAGE = 500;

export function createOperatorSessions(deps: OperatorSessionsDeps): OperatorSessions {
  const store: SessionStore = deps.store ?? {
    user: (userId, work) => withUser(deps.db, { userId }, work),
    auth: (work) => withAuth(deps.authDb, work),
  };

  async function endAll(userId: UserId): Promise<number> {
    const gone = await store.user(userId, async (tx) => {
      const rows = await tx
        .deleteFrom('sessions')
        .where('user_id', '=', sql<string>`app.current_user_id()`)
        .returning('id')
        .execute();
      // A copied device cookie must not keep its rate limit exemption either.
      await forgetDevices(tx);
      return rows.length;
    });
    quietInfo(deps.logger, 'auth.sessions_revoked', {
      scope: 'operator',
      revoked: gone,
      ...idFields({ userId: ['usr', userId] }),
    });
    return gone;
  }

  return Object.freeze({
    async revokeForEmail(email) {
      const address = normalizeAddress(email);
      if (address === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      try {
        const row = await store.auth((tx) =>
          tx
            .selectFrom('users')
            .select('id')
            .where('email_normalized', '=', address)
            .executeTakeFirst(),
        );
        if (row === undefined) return fail(new AuthError('AUTH_NOT_FOUND'));
        return ok(await endAll(idOf('usr', row.id)));
      } catch (error) {
        return fail(unavailable(error));
      }
    },

    async revokeAll() {
      let total = 0;
      let after: string | null = null;
      try {
        // Keyset pages by id, so a person who signs up meanwhile is neither skipped twice
        // nor read twice.
        for (;;) {
          const from: string | null = after;
          const page: readonly { id: string }[] = await store.auth((tx) =>
            tx
              .selectFrom('users')
              .select('id')
              .$if(from !== null, (q) => q.where('id', '>', from ?? ''))
              .orderBy('id')
              .limit(PAGE)
              .execute(),
          );
          for (const row of page) total += await endAll(idOf('usr', row.id));
          if (page.length < PAGE) break;
          after = page[page.length - 1]?.id ?? null;
        }
      } catch (error) {
        throw unavailable(error);
      }
      return total;
    },
  } satisfies OperatorSessions);
}
