import type { Result } from '@drefyn/address';
import { withAuth, withUser, type AuthDatabase, type Database } from '@drefyn/db';
import type { UserId } from '@drefyn/tenancy';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import type { AuthConfig } from './config.ts';
import { sessionCookieValue, type BrowserContext, type CookieSpec } from './cookies.ts';
import { newDeviceNotice, recordDevice } from './devices.ts';
import type { AuthNoticeMailer } from './email-change.ts';
import type { SignedIn } from './email-sign-in.ts';
import { AuthError } from './errors.ts';
import { sendFactorAlert, sendFactorNotice, startNow, type Later } from './factor-notices.ts';
import { FACTOR_CHALLENGE_ATTEMPTS, lockFactor } from './factor-rows.ts';
import {
  factorError,
  factorInput,
  reportFactor,
  reserveFactor,
  verifyFactor,
  type FactorCode,
  type FactorOutcome,
} from './factor-verify.ts';
import { checkFormBinding } from './form-binding.ts';
import { constantTimeEqual, sha256 } from './keys.ts';
import {
  createRateLimiter,
  type AuthLogger,
  type AuthMetrics,
  type RateLimiter,
} from './rate-limiter.ts';
import { safeReturnTo } from './return-to.ts';
import {
  asId,
  fail,
  ok,
  unavailable,
  type SessionInfo,
  type SessionMethod,
  type SessionStore,
  type SsoScope,
} from './session-support.ts';
import { insertProvedSession, retireSession } from './sessions.ts';
import {
  SECRET_BYTES,
  formatSessionToken,
  parseFactorToken,
  parseSessionToken,
  type FactorToken,
} from './tokens.ts';
import type { FactorKind } from './totp.ts';

export interface FactorChallengesDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: SessionStore;
  readonly logger: AuthLogger;
  // For the new device notice, which waits until the factor has passed, and the factor's
  // own notices.
  readonly mailer: Partial<AuthNoticeMailer>;
  // Where a failed attempt's notice runs, so the refusal does not wait on mail.
  readonly later?: Later;
  readonly limiter?: RateLimiter;
  readonly metrics?: AuthMetrics;
  readonly random?: (bytes: number) => Uint8Array;
}

export type FactorChallengeView = { readonly kind: 'live' } | { readonly kind: 'gone' };

export interface FactorChallenges {
  // Proves the cookie and nothing more: no count, no lock, no write.
  readChallenge(b: BrowserContext): Promise<Result<FactorChallengeView, AuthError>>;
  // Finishes the sign in the challenge stands for. End it through the same step as every
  // other sign in, so an invitation keeps its fresh form binding.
  completeChallenge(
    b: BrowserContext,
    input: FactorCode & { readonly csrf: string },
  ): Promise<Result<SignedIn, AuthError>>;
}

const METHODS: ReadonlySet<string> = new Set<SessionMethod>([
  'email',
  'password',
  'github',
  'google',
  'cli_link',
  'sso',
]);
const DAY_SECONDS = 86_400;
// Compared against on a miss, so a missing row costs the same compare as a wrong secret.
const DUMMY_HASH = Buffer.alloc(32);

interface Proved {
  readonly method: SessionMethod;
  readonly returnTo: string;
  readonly sso?: SsoScope;
}

// Thrown to roll back a transaction whose failure must not persist.
class Rollback extends Error {
  readonly reason: 'expired';
  constructor() {
    super('expired');
    this.reason = 'expired';
  }
}

export function createFactorChallenges(
  config: AuthConfig,
  deps: FactorChallengesDeps,
): FactorChallenges {
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
        }));
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const devices = { store, logger: deps.logger, random };
  const later = deps.later ?? startNow;
  const notices = { store, limiter, logger: deps.logger, mailer: deps.mailer };
  const { idleDays, absoluteDays } = config.session;
  const clear = (name: string): CookieSpec => ({ name, value: '', maxAgeSeconds: 0 });
  const report = (kind: FactorKind, outcome: FactorOutcome | 'origin', userId?: UserId) => {
    reportFactor({ logger: deps.logger, metrics: deps.metrics }, kind, outcome, userId);
  };

  // The first and only statement before the proof: the person's challenge by user id alone,
  // compared in process. Null for a wrong secret or a missing, expired or used up row.
  async function prove(token: FactorToken): Promise<Proved | null> {
    const row = await store.user(token.userId, (tx) =>
      tx
        .selectFrom('factor_challenges')
        .select([
          'secret_hash',
          'method',
          'return_to',
          'sso_connection_id',
          'sso_organization_id',
          sql<boolean>`expires_at > now() and attempts < ${sql.lit(FACTOR_CHALLENGE_ATTEMPTS)}`.as(
            'live',
          ),
        ])
        .where('user_id', '=', sql<string>`app.current_user_id()`)
        .executeTakeFirst(),
    );
    const matched = constantTimeEqual(sha256(token.secret), row?.secret_hash ?? DUMMY_HASH);
    if (row === undefined || !matched || !row.live || !METHODS.has(row.method)) return null;
    const organizationId = asId('org', row.sso_organization_id);
    const connectionId = asId('ssc', row.sso_connection_id);
    return {
      method: row.method as SessionMethod,
      returnTo: safeReturnTo(row.return_to ?? '/', config.appOrigin),
      ...(organizationId !== null && connectionId !== null
        ? { sso: { organizationId, connectionId } }
        : {}),
    };
  }

  function cookieOf(b: BrowserContext): FactorToken | null {
    return parseFactorToken(b.cookies.get(config.cookies.factor));
  }

  return Object.freeze({
    async readChallenge(b) {
      const token = cookieOf(b);
      if (token === null) return ok<FactorChallengeView>({ kind: 'gone' });
      try {
        return ok<FactorChallengeView>({ kind: (await prove(token)) === null ? 'gone' : 'live' });
      } catch (error) {
        return fail(error);
      }
    },

    async completeChallenge(b, input) {
      const kind: FactorKind = input.kind === 'recovery_code' ? 'recovery_code' : 'totp';
      // Both free checks first: a cross site post or a bad shape costs nobody anything.
      if (!checkFormBinding(config, b, input.csrf)) {
        report(kind, 'origin');
        return fail(new AuthError('AUTH_ORIGIN_REFUSED'));
      }
      const code = factorInput(input);
      if (code === null) {
        report(kind, 'invalid');
        return fail(new AuthError('AUTH_FACTOR_INVALID'));
      }
      const token = cookieOf(b);
      if (token === null) {
        report(kind, 'expired');
        return fail(new AuthError('AUTH_FACTOR_CHALLENGE_EXPIRED'));
      }
      const { userId } = token;
      try {
        // The user id in the cookie is not a secret, so nothing keyed on it is reachable
        // until the secret is proved.
        const proved = await prove(token);
        if (proved === null) {
          report(kind, 'expired');
          return fail(new AuthError('AUTH_FACTOR_CHALLENGE_EXPIRED'));
        }
        try {
          await reserveFactor(limiter, code.kind, { userId, ip: b.ip });
        } catch (error) {
          const limited = error instanceof AuthError && error.code === 'AUTH_RATE_LIMITED';
          report(kind, limited ? 'rate_limited' : 'unavailable', userId);
          return fail(error);
        }
        const secret = random(SECRET_BYTES);
        const outcome = await store.user(userId, async (tx) => {
          await lockFactor(tx, userId, 'shared');
          // Only the challenge proved above: one replaced since cannot be spent.
          const counted = await tx
            .updateTable('factor_challenges')
            .set({ attempts: sql<number>`"attempts" + 1` })
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .where('attempts', '<', FACTOR_CHALLENGE_ATTEMPTS)
            .where('expires_at', '>', sql<Date>`now()`)
            .where('secret_hash', '=', sha256(token.secret))
            .returning('user_id')
            .executeTakeFirst();
          if (counted === undefined) return { ok: false as const, reason: 'expired' as const };
          const checked = await verifyFactor(tx, { config, logger: deps.logger }, userId, code);
          if (!checked.ok) {
            // A factor removed meanwhile ends the challenge it was guarding.
            if (checked.reason === 'not_enrolled') throw new Rollback();
            return checked;
          }
          const removed = await tx
            .deleteFrom('factor_challenges')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .where('secret_hash', '=', sha256(token.secret))
            .returning('user_id')
            .executeTakeFirst();
          if (removed === undefined) throw new Rollback();
          const session = await insertProvedSession(tx, checked.proof, {
            userId,
            method: proved.method,
            ...(proved.sso === undefined ? {} : { sso: proved.sso }),
            userAgent: b.userAgent,
            secretHash: sha256(secret),
            absoluteDays,
          });
          return { ok: true as const, session, check: checked };
        });
        if (!outcome.ok) {
          const reason = outcome.reason === 'not_enrolled' ? 'expired' : outcome.reason;
          report(kind, reason, userId);
          const alert = outcome.reason === 'expired' ? null : outcome.alert;
          if (alert !== null) later(() => sendFactorAlert(notices, userId, alert));
          return fail(factorError(reason));
        }
        const { check } = outcome;
        report(kind, check.previousStep ? 'matched_previous_step' : 'passed', userId);
        const done = await signedIn(b, outcome.session, secret, proved);
        if (check.codesLeft === null) return ok(done);
        // A recovery code at sign in usually means a lost phone, so the person hears it
        // and how many codes remain.
        const used = () =>
          sendFactorNotice(
            notices,
            userId,
            { kind: 'recovery_code_used', codesLeft: check.codesLeft ?? 0, at: check.at },
            outcome.session.email,
          );
        const device = done.send;
        return ok({
          ...done,
          send: async () => {
            await device?.();
            await used();
          },
        });
      } catch (error) {
        if (error instanceof Rollback) {
          report(kind, 'expired', userId);
          return fail(new AuthError('AUTH_FACTOR_CHALLENGE_EXPIRED'));
        }
        report(kind, 'unavailable', userId);
        return fail(unavailable(error));
      }
    },
  } satisfies FactorChallenges);

  // What every sign in does once it is real, and none did while the factor was pending.
  async function signedIn(
    b: BrowserContext,
    session: SessionInfo,
    secret: Uint8Array,
    proved: Proved,
  ): Promise<SignedIn> {
    const old = parseSessionToken(sessionCookieValue(config, b.cookies));
    if (old !== null && old.sessionId !== session.sessionId) {
      await retireSession(store, idleDays, old);
    }
    const device = await recordDevice(config, devices, b, session.userId);
    const seen = device.newDevice;
    const value = formatSessionToken({
      userId: session.userId,
      sessionId: session.sessionId,
      secret,
    });
    return {
      session,
      setCookies: [
        { name: config.cookies.session, value, maxAgeSeconds: absoluteDays * DAY_SECONDS },
        clear(config.cookies.factor),
        clear(config.cookies.pre),
        clear(config.cookies.oauth),
        ...device.setCookies,
      ],
      returnTo: proved.returnTo,
      ...(seen === null
        ? {}
        : {
            send: newDeviceNotice(config, deps.mailer, deps.logger, {
              to: session.email,
              userId: session.userId,
              method: proved.method,
              seen,
            }),
          }),
    };
  }
}

function missing(): never {
  throw new TypeError('createFactorChallenges needs db and authDb, or a store and limiter');
}
