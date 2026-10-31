import type { Result } from '@drefyn/address';
import { randomInt, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { normalizeAddress } from './address.ts';
import { rateKeyForIp } from './client-ip.ts';
import type { AuthConfig } from './config.ts';
import type { BrowserContext } from './cookies.ts';
import { AuthError } from './errors.ts';
import { lengthPrefixed, sha256 } from './keys.ts';
import type { AuthLogger, RateLimiter } from './rate-limiter.ts';
import {
  fail,
  idFields,
  ok,
  quietWarn,
  unavailable,
  type SessionInfo,
  type SessionStore,
  type StepUpMethod,
} from './session-support.ts';
import { formatChallengeId, formatVerifyFragment, parseChallengeId, parseCode } from './tokens.ts';

export type SignInCodePurpose =
  'sign_in' | 'link_identity' | 'step_up' | 'password_reset' | 'email_change';

// The mail side auth needs. Invitations and security notices join it with their own flows.
export interface AuthMailer {
  sendSignInCode(
    to: string,
    code: string,
    link: URL,
    purpose: SignInCodePurpose,
    linking?: { readonly provider: 'github' | 'google'; readonly account: string },
  ): Promise<void>;
}

// Checks a password against a stored PHC string, or against a dummy when there is none, so
// both cost the same. The passwords work provides the Argon2id one.
export interface PasswordVerifier {
  verify(phc: string | null, password: string): Promise<boolean>;
}

export interface StepUps {
  // Sensitive actions call this first. Database time decides, against the row as it is
  // now, so a session revoked a moment ago fails too.
  requireRecentAuth(s: SessionInfo): Promise<Result<void, AuthError>>;
  stepUpWithPassword(
    b: BrowserContext,
    s: SessionInfo,
    input: { readonly password: string },
  ): Promise<Result<SessionInfo, AuthError>>;
  // send never throws and is meant to run after the response.
  startStepUpCode(
    b: BrowserContext,
    s: SessionInfo,
  ): Promise<Result<{ readonly challenge: string; readonly send: () => Promise<void> }, AuthError>>;
  verifyStepUpCode(
    b: BrowserContext,
    s: SessionInfo,
    input: { readonly challenge: string; readonly code: string },
  ): Promise<Result<SessionInfo, AuthError>>;
}

export interface StepUpDeps {
  readonly store: SessionStore;
  readonly limiter: RateLimiter;
  readonly logger: AuthLogger;
  readonly mailer?: AuthMailer;
  readonly passwords?: PasswordVerifier;
}

const PURPOSE = 'step_up';
const MAX_ATTEMPTS = 5;
// Raw bytes before any normalising, so a huge body never reaches the hash.
const PASSWORD_MAX_BYTES = 4096;
// People type the gap the mail shows; spaces, tabs and no break spaces are dropped and
// nothing else is.
const TYPED_GAPS = /[\u0020\t\u00a0]/g;

// A step up code works only in the session that asked for it. The session id is not
// secret; the binding is that the verify call must come with that session.
const bindingOf = (s: SessionInfo) => sha256(lengthPrefixed(['drefyn.step_up.v1', s.sessionId]));

function address(s: SessionInfo): string {
  const normalized = normalizeAddress(s.email);
  if (normalized === null) throw new AuthError('AUTH_INPUT_INVALID');
  return normalized;
}

export function stepUps(config: AuthConfig, deps: StepUpDeps): StepUps {
  const { store, limiter } = deps;

  // Refreshes authenticated_at on the same session and records how it was proved.
  async function mark(s: SessionInfo, method: StepUpMethod): Promise<SessionInfo> {
    const row = await store.user(s.userId, (tx) =>
      tx
        .updateTable('sessions')
        .set({ authenticated_at: sql<Date>`now()`, step_up_method: method })
        .where('id', '=', s.sessionId)
        .where('user_id', '=', sql<string>`app.current_user_id()`)
        .where('expires_at', '>', sql<Date>`now()`)
        .returning('authenticated_at')
        .executeTakeFirst(),
    );
    if (row === undefined) throw new AuthError('AUTH_SESSION_INVALID');
    return { ...s, authenticatedAt: row.authenticated_at, stepUpMethod: method };
  }

  return {
    async requireRecentAuth(s) {
      try {
        const row = await store.user(s.userId, (tx) =>
          tx
            .selectFrom('sessions')
            .select(sql<boolean>`authenticated_at > now() - interval '15 minutes'`.as('recent'))
            .where('id', '=', s.sessionId)
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .where('expires_at', '>', sql<Date>`now()`)
            .executeTakeFirst(),
        );
        if (row === undefined) return fail(new AuthError('AUTH_SESSION_INVALID'));
        return row.recent ? ok(undefined) : fail(new AuthError('AUTH_RECENT_AUTH_REQUIRED'));
      } catch (error) {
        return fail(error);
      }
    },

    async stepUpWithPassword(b, s, input) {
      try {
        const verifier = deps.passwords;
        if (!config.passwords.enabled || verifier === undefined) {
          throw new AuthError('AUTH_PASSWORDS_DISABLED');
        }
        if (Buffer.byteLength(input.password, 'utf8') > PASSWORD_MAX_BYTES) {
          throw new AuthError('AUTH_INPUT_INVALID');
        }
        const ipKey = rateKeyForIp(b.ip);
        // Counted before the hash and committed whatever follows, right or wrong.
        await limiter.reserve('password_fail', [address(s)]);
        await limiter.reserve('password_fail_ip', [ipKey]);
        const row = await store.user(s.userId, (tx) =>
          tx
            .selectFrom('password_credentials')
            .select('phc')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .executeTakeFirst(),
        );
        // Outside any transaction: a hash must never hold a connection.
        let matched: boolean;
        try {
          matched = await verifier.verify(row?.phc ?? null, input.password);
        } catch (error) {
          throw unavailable(error);
        }
        if (!matched) throw new AuthError('AUTH_CREDENTIALS_INVALID');
        return ok(await mark(s, 'password'));
      } catch (error) {
        return fail(error);
      }
    },

    async startStepUpCode(b, s) {
      try {
        const mailer = deps.mailer;
        if (mailer === undefined) throw new AuthError('AUTH_UNAVAILABLE');
        const to = address(s);
        const ipKey = rateKeyForIp(b.ip);
        await limiter.reserve('email_send', [to, ipKey]);
        await limiter.reserve('email_send_ip', [ipKey]);
        const id = randomUUID();
        const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
        const binding = bindingOf(s);
        await store.auth(async (tx) => {
          // A new code replaces this session's older ones, and nobody else's.
          await tx
            .deleteFrom('email_challenges')
            .where('browser_hash', '=', binding)
            .where('purpose', '=', PURPOSE)
            .where('consumed_at', 'is', null)
            .execute();
          await tx
            .insertInto('email_challenges')
            .values({
              id,
              email_normalized: to,
              purpose: PURPOSE,
              user_id: s.userId,
              code_hmac: config.keys.mac('code', [id, PURPOSE, code]),
              browser_hash: binding,
              expires_at: sql<Date>`now() + interval '10 minutes'`,
            })
            .execute();
        });
        const link = new URL(
          `/sign-in/verify#${formatVerifyFragment({ challengeId: id, code })}`,
          config.appOrigin,
        );
        const send = async () => {
          try {
            await mailer.sendSignInCode(s.email, code, link, PURPOSE);
          } catch {
            quietWarn(
              deps.logger,
              'auth.step_up_mail_failed',
              idFields({ userId: ['usr', s.userId], sessionId: ['ses', s.sessionId] }),
            );
          }
        };
        return ok({ challenge: formatChallengeId(id), send });
      } catch (error) {
        return fail(error);
      }
    },

    async verifyStepUpCode(b, s, input) {
      const id = parseChallengeId(input.challenge);
      const code = parseCode(input.code.replace(TYPED_GAPS, ''));
      if (id === null || code === null) return fail(new AuthError('AUTH_CODE_INVALID'));
      try {
        const binding = bindingOf(s);
        await limiter.reserve('code_verify', [address(s), binding]);
        const proved = await store.auth(async (tx) => {
          // The attempt is counted before the compare and commits either way. The binding is
          // in the filter, so another session's guess never spends this challenge's attempts.
          const row = await tx
            .updateTable('email_challenges')
            .set({ attempts: sql<number>`${sql.ref('attempts')} + 1` })
            .where('id', '=', id)
            .where('purpose', '=', PURPOSE)
            .where('user_id', '=', s.userId)
            .where('browser_hash', '=', binding)
            .where('consumed_at', 'is', null)
            .where('attempts', '<', MAX_ATTEMPTS)
            .where('expires_at', '>', sql<Date>`now()`)
            .returning(['code_hmac', 'user_id'])
            .executeTakeFirst();
          if (row?.user_id !== s.userId) return false;
          if (!config.keys.verify('code', [id, PURPOSE, code], row.code_hmac)) return false;
          const consumed = await tx
            .updateTable('email_challenges')
            .set({ consumed_at: sql<Date>`now()` })
            .where('id', '=', id)
            .where('consumed_at', 'is', null)
            .returning('id')
            .executeTakeFirst();
          return consumed !== undefined;
        });
        if (!proved) return fail(new AuthError('AUTH_CODE_INVALID'));
        return ok(await mark(s, 'email'));
      } catch (error) {
        return fail(error);
      }
    },
  };
}
