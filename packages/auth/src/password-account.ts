import type { Result } from '@drefyn/address';
import { withAuth, withUser, type AuthDatabase, type Database } from '@drefyn/db';
import { idOf, type UserId } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { normalizeAddress } from './address.ts';
import { rateKeyForIp } from './client-ip.ts';
import type { AuthConfig } from './config.ts';
import type { BrowserContext, CookieSpec } from './cookies.ts';
import { deviceHash, isKnownDevice, resetDevices } from './devices.ts';
import type { AuthNoticeMailer } from './email-change.ts';
import { createCodeIssuer, type SignedIn } from './email-sign-in.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import { constantTimeEqual, sha256 } from './keys.ts';
import { createPasswordHasher, type PasswordHasher } from './password-hash.ts';
import { checkNewPassword, normalizePassword } from './password-input.ts';
import type { PasswordContext } from './password-rules.ts';
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
  type SessionStore,
} from './session-support.ts';
import { createSessions, type StartSessionInput, type StartedSession } from './sessions.ts';
import type { AuthMailer } from './step-up.ts';
import { decodeSecret, parseChallengeId, parseCode } from './tokens.ts';
import { randomBytes } from 'node:crypto';

// What the password account flows need of sessions.
export interface PasswordAccountSessions {
  startSession(b: BrowserContext, input: StartSessionInput): Promise<StartedSession>;
  requireRecentAuth(s: SessionInfo): Promise<Result<void, AuthError>>;
}

export interface PasswordAccountDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: SessionStore;
  readonly logger: AuthLogger;
  readonly mailer: AuthMailer & AuthNoticeMailer;
  readonly sessions?: PasswordAccountSessions;
  readonly limiter?: RateLimiter;
  readonly metrics?: AuthMetrics;
  // One per process, shared with sign in, so one gate bounds every hash.
  readonly hasher?: PasswordHasher;
  readonly random?: (bytes: number) => Uint8Array;
}

export interface PasswordChanged {
  // The other sessions ended; this one is kept.
  readonly revoked: number;
  // A new device cookie for this browser.
  readonly setCookies: readonly CookieSpec[];
  // Mails the notice and never throws; run it after the response.
  readonly send: () => Promise<void>;
}

export interface PasswordAccount {
  // One answer for every address, with the same limits as an email sign in.
  startPasswordReset(
    b: BrowserContext,
    input: { readonly email: string },
  ): Promise<
    Result<
      { readonly setCookies: readonly CookieSpec[]; readonly send: () => Promise<void> },
      AuthError
    >
  >;
  // The code and the new password together, from the browser that asked. Saves the hash,
  // ends every session of the person and starts a fresh one here. send mails the notice.
  completePasswordReset(
    b: BrowserContext,
    input: { readonly challenge?: string; readonly code: string; readonly newPassword: string },
  ): Promise<Result<SignedIn, AuthError>>;
  // The current password, or a sign in within 15 minutes. Ends the other sessions.
  changePassword(
    b: BrowserContext,
    s: SessionInfo,
    input: { readonly currentPassword?: string; readonly newPassword: string },
  ): Promise<Result<PasswordChanged, AuthError>>;
  // Only while another way to sign in remains. Needs a sign in within 15 minutes.
  removePassword(
    s: SessionInfo,
  ): Promise<Result<{ readonly send: () => Promise<void> }, AuthError>>;
}

const PURPOSE = 'password_reset';
const MAX_ATTEMPTS = 5;
// People type the gap the mail shows; spaces, tabs and no break spaces are dropped and
// nothing else is.
const TYPED_GAPS = /[\u0020\t\u00a0]/g;

// Thrown inside a transaction to roll it back. Not a pg error, so the db layer passes it
// through untouched.
class Refused extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

type NoticeKind = 'password_changed' | 'password_reset' | 'password_removed';

interface Challenge {
  readonly id: string;
  readonly email_normalized: string;
  readonly user_id: string | null;
  readonly browser_hash: Buffer;
  readonly live: boolean;
  readonly consumed: boolean;
}

// The step every new password goes through, in the shape the breached check will share.
// TODO(#138): replace with admitNewPassword so change and reset also run the breached check.
function admitNewPassword(
  password: string,
  context: PasswordContext,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: AuthError }> {
  const rules = checkNewPassword(password, context);
  return Promise.resolve(
    rules.length === 0
      ? { ok: true }
      : { ok: false, error: new AuthError('AUTH_PASSWORD_WEAK', { rules }) },
  );
}

export function createPasswordAccount(
  config: AuthConfig,
  deps: PasswordAccountDeps,
): PasswordAccount {
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
  const hasher =
    deps.hasher ??
    createPasswordHasher({
      params: config.passwords.argon2,
      concurrency: config.passwords.hashConcurrency,
      queueMax: config.passwords.hashQueueMax,
    });
  const sessions: PasswordAccountSessions =
    deps.sessions ??
    (db !== undefined && authDb !== undefined
      ? createSessions(config, { db, authDb, logger: deps.logger, passwords: hasher })
      : missing());
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const issuer = createCodeIssuer(config, {
    store,
    logger: deps.logger,
    mailer: deps.mailer,
    ...(deps.random === undefined ? {} : { random: deps.random }),
  });

  const userIds = (userId: UserId) => idFields({ userId: ['usr', userId] });
  const sessionIds = (s: SessionInfo) =>
    idFields({ userId: ['usr', s.userId], sessionId: ['ses', s.sessionId] });

  // Outcome codes and ids only: never an address, a code or a password.
  function refused(code: AuthErrorCode, ids: Record<string, string> = {}) {
    quietInfo(deps.logger, 'auth.password_account_refused', { outcome: code, ...ids });
    return fail<never>(new AuthError(code));
  }

  function notice(to: string, userId: UserId, kind: NoticeKind, at: Date) {
    return async () => {
      try {
        await deps.mailer.sendSecurityNotice(to, { kind, at });
      } catch {
        quietWarn(deps.logger, 'auth.password_notice_failed', userIds(userId));
      }
    };
  }

  // The new password as stored, or the refusal. The hash runs outside any transaction.
  async function admitted(raw: string, email: string): Promise<string> {
    const password = normalizePassword(raw);
    const admission = await admitNewPassword(password, { email });
    if (!admission.ok) throw admission.error;
    return password;
  }

  async function readChallenge(id: string | null, binding: Buffer) {
    return store.auth(async (tx) => {
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
        .where('purpose', '=', PURPOSE);
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
  }

  return Object.freeze({
    async startPasswordReset(b, input) {
      if (!config.passwords.enabled) return fail(new AuthError('AUTH_PASSWORDS_DISABLED'));
      const address = normalizeAddress(input.email);
      if (address === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      try {
        const ipKey = rateKeyForIp(b.ip);
        await limiter.reserve('email_send', [address, ipKey]);
        await limiter.reserve('email_send_ip', [ipKey]);
        const hash = deviceHash(config, b);
        // The same two statements for every address, known or not.
        const { userId, known } = await store.auth(async (tx) => {
          const user = await tx
            .selectFrom('users')
            .select('id')
            .where('email_normalized', '=', address)
            .executeTakeFirst();
          const found = user === undefined ? null : idOf('usr', user.id);
          return { userId: found, known: await isKnownDevice(tx, found, hash) };
        });
        if (known && hash !== null) await limiter.reserve('email_send_device', [address, hash]);
        else await limiter.reserve('email_send_address_ceiling', [address]);
        // An unknown address gets the same stored row and no mail, and its code can never
        // be proved, so nothing it leads to can create an account.
        const issued = await issuer.issue(b, {
          purpose: PURPOSE,
          email: address,
          userId,
          deliver: userId !== null,
          provable: userId !== null,
        });
        if (!issued.ok) return issued;
        return ok({ setCookies: issued.value.setCookies, send: issued.value.send });
      } catch (error) {
        return fail(error);
      }
    },

    async completePasswordReset(b, input) {
      if (!config.passwords.enabled) return fail(new AuthError('AUTH_PASSWORDS_DISABLED'));
      const code = parseCode(input.code.replace(TYPED_GAPS, ''));
      const id = input.challenge === undefined ? null : parseChallengeId(input.challenge);
      if (code === null || (input.challenge !== undefined && id === null)) {
        return refused('AUTH_CODE_INVALID');
      }
      const pre = decodeSecret(b.cookies.get(config.cookies.pre));
      if (pre === null) return refused('AUTH_CHALLENGE_BINDING');
      const binding = sha256(pre);
      try {
        // Read only: the binding is checked before anything is counted, so a code tried in
        // another browser costs the person no attempt.
        const challenge = await readChallenge(id, binding);
        if (challenge === undefined || challenge.consumed) return refused('AUTH_CODE_INVALID');
        if (!constantTimeEqual(challenge.browser_hash, binding)) {
          return refused('AUTH_CHALLENGE_BINDING');
        }
        if (!challenge.live) return refused('AUTH_CHALLENGE_EXPIRED');
        const address = challenge.email_normalized;
        // Before the attempt: a refused password leaves the person all their tries.
        const password = await admitted(input.newPassword, address);
        await limiter.reserve('code_verify', [address, binding]);
        const matched = await store.auth(async (tx) => {
          // Counted before the compare, in a statement only five can ever pass.
          const row = await tx
            .updateTable('email_challenges')
            .set({ attempts: sql<number>`${sql.ref('attempts')} + 1` })
            .where('id', '=', challenge.id)
            .where('purpose', '=', PURPOSE)
            .where('browser_hash', '=', binding)
            .where('consumed_at', 'is', null)
            .where('attempts', '<', MAX_ATTEMPTS)
            .where('expires_at', '>', sql<Date>`now()`)
            .returning('code_hmac')
            .executeTakeFirst();
          if (row === undefined) return 'AUTH_CHALLENGE_EXPIRED' as const;
          return config.keys.verify('code', [challenge.id, PURPOSE, code], row.code_hmac)
            ? ('matched' as const)
            : ('AUTH_CODE_INVALID' as const);
        });
        if (matched !== 'matched') return refused(matched);
        // An unknown address stores a code nothing can match; this is only a second lock.
        if (challenge.user_id === null) return refused('AUTH_CODE_INVALID');
        const userId = idOf('usr', challenge.user_id);
        // The hash comes before the code is spent, so a full hash queue costs no code.
        const phc = await hasher.hash(password);
        const consumed = await store.auth((tx) =>
          tx
            .updateTable('email_challenges')
            .set({ consumed_at: sql<Date>`now()` })
            .where('id', '=', challenge.id)
            .where('consumed_at', 'is', null)
            .returning('id')
            .executeTakeFirst(),
        );
        // Another tab finished this reset during the hash.
        if (consumed === undefined) return refused('AUTH_CODE_INVALID');
        const { at, deviceCookies } = await store.user(userId, async (tx) => {
          // Writing the hash takes the row lock first, so a sign in that checked the old
          // hash either finds it gone or created its session before the delete below.
          const saved = await tx
            .insertInto('password_credentials')
            .values({ user_id: userId, phc })
            .onConflict((c) =>
              c.column('user_id').doUpdateSet({ phc, updated_at: sql<Date>`now()` }),
            )
            .returning('updated_at')
            .executeTakeFirstOrThrow();
          await tx
            .deleteFrom('sessions')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .execute();
          // A copied device cookie must not keep its allowance past a reset either.
          const cookies = await resetDevices(tx, config, userId, b.userAgent, random);
          return { at: saved.updated_at, deviceCookies: cookies };
        });
        const started = await sessions.startSession(b, { userId, method: 'email' });
        quietInfo(deps.logger, 'auth.password_reset', userIds(userId));
        return ok({
          session: started.session,
          setCookies: [...started.setCookies, ...deviceCookies],
          returnTo: '/',
          send: notice(started.session.email, userId, 'password_reset', at),
        });
      } catch (error) {
        return fail(error);
      }
    },

    async changePassword(b, s, input) {
      if (!config.passwords.enabled) return fail(new AuthError('AUTH_PASSWORDS_DISABLED'));
      try {
        const password = await admitted(input.newPassword, s.email);
        const current =
          input.currentPassword === undefined
            ? undefined
            : normalizePassword(input.currentPassword);
        if (current !== undefined) {
          const address = normalizeAddress(s.email);
          if (address === null) throw new AuthError('AUTH_SESSION_INVALID');
          // Counted before the hash and committed whatever follows, like a sign in.
          await limiter.reserve('password_fail', [address]);
          await limiter.reserve('password_fail_ip', [rateKeyForIp(b.ip)]);
        } else {
          const recent = await sessions.requireRecentAuth(s);
          if (!recent.ok) return recent;
        }
        const row = await store.user(s.userId, (tx) =>
          tx
            .selectFrom('password_credentials')
            .select('phc')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .executeTakeFirst(),
        );
        if (current !== undefined) {
          // Outside any transaction; no row still costs a full verify.
          const checked = await hasher.check(row?.phc ?? null, current);
          if (!checked.matched || row === undefined) {
            return refused('AUTH_CREDENTIALS_INVALID', sessionIds(s));
          }
        } else if (row === undefined) {
          return refused('AUTH_NOT_FOUND', sessionIds(s));
        }
        const phc = await hasher.hash(password);
        const changed = await store.user(s.userId, async (tx) => {
          const live = await tx
            .selectFrom('sessions')
            .select('id')
            .where('id', '=', s.sessionId)
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .where('expires_at', '>', sql<Date>`now()`)
            .forUpdate()
            .executeTakeFirst();
          if (live === undefined) throw new Refused('AUTH_SESSION_INVALID');
          // Only from the hash read above: a change in another tab during the hash wins.
          const saved = await tx
            .updateTable('password_credentials')
            .set({ phc, updated_at: sql<Date>`now()` })
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .where('phc', '=', row.phc)
            .returning('updated_at')
            .executeTakeFirst();
          if (saved === undefined) throw new Refused('AUTH_CREDENTIALS_INVALID');
          const gone = await tx
            .deleteFrom('sessions')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .where('id', '<>', s.sessionId)
            .returning('id')
            .execute();
          const cookies = await resetDevices(tx, config, s.userId, b.userAgent, random);
          return { at: saved.updated_at, revoked: gone.length, cookies };
        });
        quietInfo(deps.logger, 'auth.password_changed', {
          revoked: changed.revoked,
          ...sessionIds(s),
        });
        return ok({
          revoked: changed.revoked,
          setCookies: changed.cookies,
          send: notice(s.email, s.userId, 'password_changed', changed.at),
        });
      } catch (error) {
        if (error instanceof Refused) return refused(error.code, sessionIds(s));
        return fail(error);
      }
    },

    async removePassword(s) {
      try {
        const recent = await sessions.requireRecentAuth(s);
        if (!recent.ok) return recent;
        const at = await store.user(s.userId, async (tx) => {
          // The person's row first, as unlinking does, so the two cannot both pass the
          // check below and leave no way in.
          await tx
            .selectFrom('users')
            .select('id')
            .where('id', '=', s.userId)
            .forNoKeyUpdate()
            .executeTakeFirst();
          const identities = await tx
            .selectFrom('identities')
            .select('id')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .execute();
          // With email off, a password with no linked provider is the only way back in.
          if (identities.length === 0 && config.email === 'off') {
            throw new Refused('AUTH_FORBIDDEN');
          }
          const gone = await tx
            .deleteFrom('password_credentials')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .returning(sql<Date>`now()`.as('at'))
            .executeTakeFirst();
          if (gone === undefined) throw new Refused('AUTH_NOT_FOUND');
          return gone.at;
        });
        quietInfo(deps.logger, 'auth.password_removed', sessionIds(s));
        return ok({ send: notice(s.email, s.userId, 'password_removed', at) });
      } catch (error) {
        if (error instanceof Refused) return refused(error.code, sessionIds(s));
        return fail(error);
      }
    },
  } satisfies PasswordAccount);
}

function missing(): never {
  throw new TypeError(
    'createPasswordAccount needs db and authDb, or a store, limiter and sessions',
  );
}
