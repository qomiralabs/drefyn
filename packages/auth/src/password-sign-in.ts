import type { Result } from '@drefyn/address';
import { withAuth, withUser, type AuthDatabase, type Database } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { normalizeAddress } from './address.ts';
import { rateKeyForIp } from './client-ip.ts';
import type { AuthConfig } from './config.ts';
import { PRE_MAX_AGE_SECONDS, type BrowserContext, type CookieSpec } from './cookies.ts';
import { newDeviceNotice, recordDevice } from './devices.ts';
import type { AuthNoticeMailer } from './email-change.ts';
import type { SignedIn } from './email-sign-in.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import { createPasswordHasher, type PasswordHasher } from './password-hash.ts';
import { checkNewPassword, normalizePassword } from './password-input.ts';
import { createRateLimiter, type AuthLogger, type RateLimiter } from './rate-limiter.ts';
import { safeReturnTo } from './return-to.ts';
import {
  fail,
  idFields,
  ok,
  quietWarn,
  type SessionInfo,
  type SessionStore,
} from './session-support.ts';
import { createSessions, type StartSessionInput, type StartedSession } from './sessions.ts';
import { SECRET_BYTES, decodeSecret, encodeSecret } from './tokens.ts';

// The hosted bot check. Unset in the open core, where the throttle stands alone.
export interface BotCheck {
  verify(
    token: string | undefined,
    ip: string,
    action: 'sign_up' | 'password_sign_in',
  ): Promise<boolean>;
}

// What password sign in needs of sessions.
export interface PasswordSessions {
  startSession(b: BrowserContext, input: StartSessionInput): Promise<StartedSession>;
  requireRecentAuth(s: SessionInfo): Promise<Result<void, AuthError>>;
}

export interface PasswordSignInDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: SessionStore;
  readonly logger: AuthLogger;
  readonly sessions?: PasswordSessions;
  readonly limiter?: RateLimiter;
  // One per process, shared with sessions for step up, so one gate bounds every hash.
  readonly hasher?: PasswordHasher;
  readonly botCheck?: BotCheck;
  // Security notices: a first password and a sign in from a new device. Without one, each
  // notice is logged as failed.
  readonly mailer?: Partial<AuthNoticeMailer>;
  readonly random?: (bytes: number) => Uint8Array;
}

export interface PasswordForm {
  readonly setCookies: readonly CookieSpec[];
  // The hidden field: an HMAC of the browser's pre sign in secret, which a page on another
  // origin can neither read nor make.
  readonly csrf: string;
}

export interface PasswordSignInInput {
  readonly email: string;
  readonly password: string;
  readonly csrf: string;
  readonly returnTo?: string;
  readonly botToken?: string;
}

export interface PasswordSignIn {
  // For the form's GET.
  passwordForm(b: BrowserContext): PasswordForm;
  // One answer, AUTH_CREDENTIALS_INVALID, for an unknown address, a user with no password and
  // a wrong password, after the same work. Never creates an account.
  signInWithPassword(
    b: BrowserContext,
    input: PasswordSignInInput,
  ): Promise<Result<SignedIn, AuthError>>;
  // A first password, after an email code or provider sign in. Changing one that is set is
  // the reset and change flow's job.
  // send mails the password set notice and never throws; run it after the response.
  setPassword(
    s: SessionInfo,
    input: { readonly newPassword: string },
  ): Promise<Result<{ readonly send: () => Promise<void> }, AuthError>>;
}

const CSRF_LABEL = 'drefyn.pre_form.v1';
const CSRF_FIELD = /^[A-Za-z0-9_-]{43}$/;
const LOGGED_KEY_HEX = 16;
// A hosted check that has not answered by now counts as a refusal.
const BOT_CHECK_TIMEOUT_MS = 3_000;
// A change between the read and the session gets one more look, at what is stored now.
const ATTEMPTS = 2;

// Routine events go to info, or to warn for a sink that has only warn.
function note(logger: AuthLogger, event: string, fields: Readonly<Record<string, string>>): void {
  try {
    (logger.info ?? logger.warn).call(logger, event, fields);
  } catch {
    // A log line is never worth a failed request.
  }
}

function stale(error: unknown): boolean {
  return error instanceof AuthError && error.code === 'AUTH_CREDENTIALS_INVALID';
}

export function createPasswordSignIn(config: AuthConfig, deps: PasswordSignInDeps): PasswordSignIn {
  const { db, authDb } = deps;
  const random = deps.random ?? ((n: number) => randomBytes(n));
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
  const hasher =
    deps.hasher ??
    createPasswordHasher({
      params: config.passwords.argon2,
      concurrency: config.passwords.hashConcurrency,
      queueMax: config.passwords.hashQueueMax,
    });
  const sessions: PasswordSessions =
    deps.sessions ??
    (db !== undefined && authDb !== undefined
      ? createSessions(config, { db, authDb, logger: deps.logger, passwords: hasher })
      : missing());
  const mailer: Partial<AuthNoticeMailer> = deps.mailer ?? {};
  const devices = {
    store,
    logger: deps.logger,
    ...(deps.random === undefined ? {} : { random: deps.random }),
  };

  // Open sign up with no bot check leaves the throttle as the only brake on stuffing; the
  // operator should know at start, once.
  if (config.signUp === 'open' && deps.botCheck === undefined) {
    quietWarn(deps.logger, 'auth.signup_open_without_bot_check', {});
  }

  const csrfOf = (pre: Uint8Array) =>
    config.keys.mac('csrf', [CSRF_LABEL, pre]).toString('base64url');

  function bound(b: BrowserContext, field: string): boolean {
    const pre = decodeSecret(b.cookies.get(config.cookies.pre));
    if (pre === null || !CSRF_FIELD.test(field)) return false;
    return config.keys.verify('csrf', [CSRF_LABEL, pre], Buffer.from(field, 'base64url'));
  }

  // Outcome codes and hashed keys only.
  function refused(code: AuthErrorCode, address?: string) {
    const fields: Record<string, string> = { outcome: code };
    if (address !== undefined) {
      fields['bucket'] = 'password_fail';
      fields['key'] = limiter
        .keyFor('password_fail', [address])
        .toString('hex')
        .slice(0, LOGGED_KEY_HEX);
    }
    note(deps.logger, 'auth.password_refused', fields);
    return fail<never>(new AuthError(code));
  }

  async function botChecked(token: string | undefined, ip: string): Promise<void> {
    const check = deps.botCheck;
    if (check === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const passed = await Promise.race([
      check.verify(token, ip, 'password_sign_in'),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, BOT_CHECK_TIMEOUT_MS);
      }),
    ])
      .catch(() => false)
      .finally(() => {
        clearTimeout(timer);
      });
    if (!passed) throw new AuthError('AUTH_BOT_CHECK_REQUIRED');
  }

  // Step 1's read: the user and their hash in one statement, the same for every address.
  async function stored(address: string) {
    const row = await store.auth((tx) =>
      tx
        .selectFrom('users')
        .leftJoin('password_credentials', 'password_credentials.user_id', 'users.id')
        .select(['users.id as id', 'password_credentials.phc as phc'])
        .where('users.email_normalized', '=', address)
        .executeTakeFirst(),
    );
    return row === undefined ? null : { userId: idOf('usr', row.id), phc: row.phc };
  }

  async function signIn(
    b: BrowserContext,
    input: PasswordSignInInput,
    address: string,
    password: string,
  ): Promise<Result<SignedIn, AuthError>> {
    for (let attempt = 1; ; attempt += 1) {
      const found = await stored(address);
      // Step 2, outside any transaction: no connection is held while the hash runs.
      const checked = await hasher.check(found?.phc ?? null, password);
      if (!checked.readable && found !== null) {
        quietWarn(
          deps.logger,
          'auth.password_hash_unreadable',
          idFields({ userId: ['usr', found.userId] }),
        );
      }
      if (!checked.matched || found?.phc == null) {
        return refused('AUTH_CREDENTIALS_INVALID', address);
      }
      const rehash = checked.rehash ? await hasher.hash(password) : undefined;
      let started: StartedSession;
      try {
        // Step 3: the session exists only if the hash checked is still the stored one.
        started = await sessions.startSession(b, {
          userId: found.userId,
          method: 'password',
          credential: rehash === undefined ? { phc: found.phc } : { phc: found.phc, rehash },
        });
      } catch (error) {
        if (!stale(error)) throw error;
        if (attempt < ATTEMPTS) continue;
        return refused('AUTH_CREDENTIALS_INVALID', address);
      }
      const device = await recordDevice(config, devices, b, found.userId);
      const seen = device.newDevice;
      return ok({
        session: started.session,
        setCookies: [...started.setCookies, ...device.setCookies],
        returnTo: safeReturnTo(input.returnTo, config.appOrigin),
        ...(seen === null
          ? {}
          : {
              send: newDeviceNotice(config, mailer, deps.logger, {
                to: started.session.email,
                userId: found.userId,
                method: 'password',
                seen,
              }),
            }),
      });
    }
  }

  return Object.freeze({
    passwordForm(b) {
      const pre =
        decodeSecret(b.cookies.get(config.cookies.pre)) ?? Buffer.from(random(SECRET_BYTES));
      return {
        setCookies: [
          {
            name: config.cookies.pre,
            value: encodeSecret(pre),
            maxAgeSeconds: PRE_MAX_AGE_SECONDS,
          },
        ],
        csrf: csrfOf(pre),
      };
    },

    async signInWithPassword(b, input) {
      if (!config.passwords.enabled) return fail(new AuthError('AUTH_PASSWORDS_DISABLED'));
      // Before anything is counted: a cross site post costs the person nothing.
      if (!bound(b, input.csrf)) return refused('AUTH_ORIGIN_REFUSED');
      const address = normalizeAddress(input.email);
      if (address === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      let password: string;
      try {
        password = normalizePassword(input.password);
      } catch (error) {
        return fail(error);
      }
      try {
        // Attempts, not failures, counted before any hash and committed whatever follows.
        await limiter.reserve('password_fail', [address]);
        await limiter.reserve('password_fail_ip', [rateKeyForIp(b.ip)]);
        await botChecked(input.botToken, b.ip);
        return await signIn(b, input, address, password);
      } catch (error) {
        if (error instanceof AuthError && error.code === 'AUTH_RATE_LIMITED') {
          refused('AUTH_RATE_LIMITED', address);
        }
        return fail(error);
      }
    },

    async setPassword(s, input) {
      if (!config.passwords.enabled) return fail(new AuthError('AUTH_PASSWORDS_DISABLED'));
      let password: string;
      try {
        password = normalizePassword(input.newPassword);
      } catch (error) {
        return fail(error);
      }
      const rules = checkNewPassword(password, { email: s.email });
      if (rules.length > 0) return fail(new AuthError('AUTH_PASSWORD_WEAK', { rules }));
      try {
        const recent = await sessions.requireRecentAuth(s);
        if (!recent.ok) return recent;
        const existing = await store.user(s.userId, (tx) =>
          tx
            .selectFrom('password_credentials')
            .select('user_id')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .executeTakeFirst(),
        );
        if (existing !== undefined) return fail(new AuthError('AUTH_FORBIDDEN'));
        // Outside any transaction, like every hash.
        const phc = await hasher.hash(password);
        const made = await store.user(s.userId, (tx) =>
          tx
            .insertInto('password_credentials')
            .values({ user_id: s.userId, phc })
            .onConflict((c) => c.column('user_id').doNothing())
            .returning(['user_id', 'created_at'])
            .executeTakeFirst(),
        );
        // Another tab set one during the hash; that one stands.
        if (made === undefined) return fail(new AuthError('AUTH_FORBIDDEN'));
        const ids = idFields({ userId: ['usr', s.userId] });
        note(deps.logger, 'auth.password_set', ids);
        return ok({
          send: async () => {
            try {
              const send = mailer.sendSecurityNotice;
              if (send === undefined) throw new Error('no notice mailer');
              await send.call(mailer, s.email, { kind: 'password_set', at: made.created_at });
            } catch {
              quietWarn(deps.logger, 'auth.password_notice_failed', ids);
            }
          },
        });
      } catch (error) {
        return fail(error);
      }
    },
  } satisfies PasswordSignIn);
}

function missing(): never {
  throw new TypeError('createPasswordSignIn needs db and authDb, or a store, limiter and sessions');
}
