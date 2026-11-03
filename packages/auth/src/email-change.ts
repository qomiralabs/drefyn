import type { Result } from '@drefyn/address';
import { DbError, withAuth, withUser, type AuthDatabase, type Database } from '@drefyn/db';
import type { IdOf, OrganizationId } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { normalizeAddress } from './address.ts';
import { rateKeyForIp } from './client-ip.ts';
import type { AuthConfig } from './config.ts';
import type { BrowserContext, CookieSpec } from './cookies.ts';
import { createCodeIssuer } from './email-sign-in.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import { constantTimeEqual, sha256 } from './keys.ts';
import {
  createRateLimiter,
  type AuthLogger,
  type AuthMetrics,
  type RateLimiter,
} from './rate-limiter.ts';
import {
  fail,
  idFields,
  ok,
  quietInfo,
  quietWarn,
  type SessionInfo,
  type SessionMethod,
  type SessionStore,
} from './session-support.ts';
import { stepUps, type AuthMailer } from './step-up.ts';
import { decodeSecret, parseChallengeId, parseCode } from './tokens.ts';

// Security notices auth sends. The app maps each onto the mail package's notice, with every
// value as plain text.
export type AuthSecurityNotice =
  // To the old address.
  | {
      readonly kind: 'email_changed';
      readonly newAddress: string;
      // Database time of the change.
      readonly at: Date;
    }
  // To the account's address, on every provider link and unlink.
  | {
      readonly kind: 'identity_linked' | 'identity_unlinked';
      readonly provider: 'github' | 'google';
      // The provider address the identity was linked with.
      readonly account: string;
      readonly at: Date;
    }
  // To the account's address whenever its password is set, changed, reset or removed.
  | {
      readonly kind: 'password_set' | 'password_changed' | 'password_reset' | 'password_removed';
      readonly at: Date;
    }
  // To the account's address on a sign in from a device it has not used in 90 days.
  | {
      readonly kind: 'new_device_sign_in';
      readonly method: SessionMethod;
      // The coarse browser and system name, never the full user agent.
      readonly device: string;
      readonly at: Date;
      readonly sessionsLink: URL;
    }
  // To every owner, on a new API key.
  | {
      readonly kind: 'api_key_created';
      readonly organizationId: OrganizationId;
      readonly keyId: IdOf<'key'>;
      readonly keyName: string;
      // The last 4 characters, the only part of the key ever shown again.
      readonly displaySuffix: string;
      // Database time of the creation.
      readonly at: Date;
    };

export interface AuthNoticeMailer {
  sendSecurityNotice(to: string, notice: AuthSecurityNotice): Promise<void>;
}

export interface EmailChangeDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: SessionStore;
  readonly limiter?: RateLimiter;
  readonly metrics?: AuthMetrics;
  readonly logger: AuthLogger;
  readonly mailer: AuthMailer & AuthNoticeMailer;
  readonly random?: (bytes: number) => Uint8Array;
}

export interface EmailChange {
  // One answer whether or not the new address is taken: the same cookies, the same shape,
  // the same statements. A taken address gets no mail and a code that can never verify.
  startEmailChange(
    b: BrowserContext,
    s: SessionInfo,
    input: { readonly newEmail: string },
  ): Promise<
    Result<
      { readonly setCookies: readonly CookieSpec[]; readonly send: () => Promise<void> },
      AuthError
    >
  >;
  // Without a challenge id (a typed code, scripts off) this browser's newest open change
  // challenge for the user is used. send mails the notice to the old address and never
  // throws; run it after the response.
  completeEmailChange(
    b: BrowserContext,
    s: SessionInfo,
    input: { readonly challenge?: string; readonly code: string },
  ): Promise<Result<{ readonly send: () => Promise<void> }, AuthError>>;
}

const PURPOSE = 'email_change';
const MAX_ATTEMPTS = 5;
// People type the gap the mail shows; spaces, tabs and no break spaces are dropped and
// nothing else is.
const TYPED_GAPS = /[\u0020\t\u00a0]/g;

// Thrown inside the change transaction to roll it back. Not a pg error, so the db layer
// passes it through untouched.
class Refused extends Error {}
const REFUSED = new Refused('refused');

interface Challenge {
  readonly id: string;
  readonly email_normalized: string;
  readonly user_id: string | null;
  readonly browser_hash: Buffer;
  readonly live: boolean;
  readonly consumed: boolean;
}

export function createEmailChange(config: AuthConfig, deps: EmailChangeDeps): EmailChange {
  const { db, authDb } = deps;
  const store: SessionStore =
    deps.store ??
    (db !== undefined && authDb !== undefined
      ? {
          user: (userId, work) => withUser(db, { userId }, work),
          auth: (work) => withAuth(authDb, work),
        }
      : missing());
  const limiter =
    deps.limiter ??
    (authDb === undefined
      ? missing()
      : createRateLimiter({
          db: authDb,
          keys: config.keys,
          limits: config.rateLimits,
          logger: deps.logger,
          ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }),
        }));
  const recency = stepUps(config, { store, limiter, logger: deps.logger });
  const issuer = createCodeIssuer(config, {
    store,
    logger: deps.logger,
    mailer: deps.mailer,
    ...(deps.random === undefined ? {} : { random: deps.random }),
  });

  const ids = (s: SessionInfo) =>
    idFields({ userId: ['usr', s.userId], sessionId: ['ses', s.sessionId] });

  // Outcome codes and ids only: nothing the person typed or was sent.
  function refused(s: SessionInfo, code: AuthErrorCode) {
    quietInfo(deps.logger, 'auth.email_change_refused', { outcome: code, ...ids(s) });
    return fail<never>(new AuthError(code));
  }

  // A failure here leaves the change in place: the address already moved, and an error
  // would only tell the person it had not.
  async function endOtherSessions(s: SessionInfo): Promise<number> {
    try {
      const gone = await store.user(s.userId, (tx) =>
        tx
          .deleteFrom('sessions')
          .where('user_id', '=', sql<string>`app.current_user_id()`)
          .where('id', '<>', s.sessionId)
          .returning('id')
          .execute(),
      );
      return gone.length;
    } catch {
      quietWarn(deps.logger, 'auth.email_change_sessions_kept', ids(s));
      return 0;
    }
  }

  return Object.freeze({
    async startEmailChange(b, s, input) {
      const next = normalizeAddress(input.newEmail);
      if (next === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      try {
        const recent = await recency.requireRecentAuth(s);
        if (!recent.ok) return recent;
        const ipKey = rateKeyForIp(b.ip);
        await limiter.reserve('email_send', [next, ipKey]);
        await limiter.reserve('email_send_ip', [ipKey]);
        await limiter.reserve('email_send_address_ceiling', [next]);
        const owner = await store.auth((tx) =>
          tx
            .selectFrom('users')
            .select('id')
            .where('email_normalized', '=', next)
            .executeTakeFirst(),
        );
        const free = owner === undefined;
        const issued = await issuer.issue(b, {
          purpose: PURPOSE,
          email: next,
          userId: s.userId,
          deliver: free,
          provable: free,
        });
        if (!issued.ok) return issued;
        quietInfo(deps.logger, 'auth.email_change_started', ids(s));
        return ok({ setCookies: issued.value.setCookies, send: issued.value.send });
      } catch (error) {
        return fail(error);
      }
    },

    async completeEmailChange(b, s, input) {
      const code = parseCode(input.code.replace(TYPED_GAPS, ''));
      const id = input.challenge === undefined ? null : parseChallengeId(input.challenge);
      if (code === null || (input.challenge !== undefined && id === null)) {
        return refused(s, 'AUTH_CODE_INVALID');
      }
      try {
        const recent = await recency.requireRecentAuth(s);
        if (!recent.ok) return recent;
        const pre = decodeSecret(b.cookies.get(config.cookies.pre));
        if (pre === null) return refused(s, 'AUTH_CHALLENGE_BINDING');
        const binding = sha256(pre);
        const old = normalizeAddress(s.email);
        if (old === null) return fail(new AuthError('AUTH_SESSION_INVALID'));
        // Read only, and only among this user's change challenges: a code another user
        // started is not found here, so it spends no attempt and proves nothing.
        const challenge = await store.auth(async (tx) => {
          let query = tx
            .selectFrom('email_challenges')
            .select([
              'id',
              'email_normalized',
              'user_id',
              'browser_hash',
              sql<boolean>`expires_at > now() and attempts < ${MAX_ATTEMPTS}`.as('live'),
              sql<boolean>`consumed_at is not null`.as('consumed'),
            ])
            .where('purpose', '=', PURPOSE)
            .where('user_id', '=', s.userId);
          query =
            id === null
              ? query
                  .where('browser_hash', '=', binding)
                  .where('consumed_at', 'is', null)
                  .orderBy('created_at', 'desc')
                  .limit(1)
              : query.where('id', '=', id);
          const found: Challenge | undefined = await query.executeTakeFirst();
          return found;
        });
        if (challenge === undefined || challenge.consumed || challenge.user_id !== s.userId) {
          return refused(s, 'AUTH_CODE_INVALID');
        }
        if (!constantTimeEqual(challenge.browser_hash, binding)) {
          return refused(s, 'AUTH_CHALLENGE_BINDING');
        }
        if (!challenge.live) return refused(s, 'AUTH_CHALLENGE_EXPIRED');
        const next = challenge.email_normalized;
        await limiter.reserve('code_verify', [next, binding]);
        const outcome = await store.auth(async (tx) => {
          // Counted before the compare, in a statement only five can ever pass.
          const row = await tx
            .updateTable('email_challenges')
            .set({ attempts: sql<number>`${sql.ref('attempts')} + 1` })
            .where('id', '=', challenge.id)
            .where('purpose', '=', PURPOSE)
            .where('user_id', '=', s.userId)
            .where('browser_hash', '=', binding)
            .where('consumed_at', 'is', null)
            .where('attempts', '<', MAX_ATTEMPTS)
            .where('expires_at', '>', sql<Date>`now()`)
            .returning('code_hmac')
            .executeTakeFirst();
          if (row === undefined) return 'AUTH_CHALLENGE_EXPIRED' as const;
          if (!config.keys.verify('code', [challenge.id, PURPOSE, code], row.code_hmac)) {
            return 'AUTH_CODE_INVALID' as const;
          }
          const consumed = await tx
            .updateTable('email_challenges')
            .set({ consumed_at: sql<Date>`now()` })
            .where('id', '=', challenge.id)
            .where('consumed_at', 'is', null)
            .returning('id')
            .executeTakeFirst();
          return consumed === undefined ? ('AUTH_CODE_INVALID' as const) : ('proved' as const);
        });
        if (outcome !== 'proved') return refused(s, outcome);
        let changedAt: Date;
        try {
          changedAt = await store.auth(async (tx) => {
            // Guarded on the old address, so a change that raced this one moves nothing.
            const row = await tx
              .updateTable('users')
              .set({
                email: next,
                email_normalized: next,
                email_verified_at: sql<Date>`now()`,
                updated_at: sql<Date>`now()`,
              })
              .where('id', '=', s.userId)
              .where('email_normalized', '=', old)
              .returning('updated_at')
              .executeTakeFirst();
            if (row === undefined) throw REFUSED;
            // Every open code tied to the user or mailed to the old address: a sign in code
            // still sitting in the old inbox would otherwise open the account after the move.
            await tx
              .deleteFrom('email_challenges')
              .where('consumed_at', 'is', null)
              .where((eb) =>
                eb.or([eb('user_id', '=', s.userId), eb('email_normalized', '=', old)]),
              )
              .execute();
            return row.updated_at;
          });
        } catch (error) {
          // A sign up of the same address won the race. Same answer as a wrong code, so the
          // response never says the address has an account.
          if (
            error === REFUSED ||
            (error instanceof DbError && error.code === 'DB_UNIQUE_VIOLATION')
          ) {
            return refused(s, 'AUTH_CODE_INVALID');
          }
          throw error;
        }
        const revoked = await endOtherSessions(s);
        quietInfo(deps.logger, 'auth.email_changed', { revoked, ...ids(s) });
        const send = async () => {
          try {
            await deps.mailer.sendSecurityNotice(old, {
              kind: 'email_changed',
              newAddress: next,
              at: changedAt,
            });
          } catch {
            quietWarn(deps.logger, 'auth.email_change_notice_failed', ids(s));
          }
        };
        return ok({ send });
      } catch (error) {
        return fail(error);
      }
    },
  } satisfies EmailChange);
}

function missing(): never {
  throw new TypeError('createEmailChange needs db and authDb, or a store and limiter');
}
