import type { Result } from '@drefyn/address';
import { newId, withAuth, withUser, type AuthDatabase, type Database } from '@drefyn/db';
import { idOf, type UserId } from '@drefyn/tenancy';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { normalizeAddress } from './address.ts';
import { rateKeyForIp } from './client-ip.ts';
import type { AuthConfig } from './config.ts';
import { PRE_MAX_AGE_SECONDS, type BrowserContext, type CookieSpec } from './cookies.ts';
import {
  deviceHash,
  isKnownDevice,
  newDeviceNotice,
  recordDevice,
  sendBoth,
  type RecordedDevice,
} from './devices.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import { constantTimeEqual, sha256 } from './keys.ts';
import {
  createRateLimiter,
  type AuthLogger,
  type AuthMetrics,
  type RateLimiter,
} from './rate-limiter.ts';
import { safeReturnTo } from './return-to.ts';
import {
  fail,
  ok,
  unavailable,
  type SessionInfo,
  type SessionMethod,
  type SessionStore,
} from './session-support.ts';
import { createSessions, type StartedSession } from './sessions.ts';
import type { AuthMailer, SignInCodePurpose } from './step-up.ts';
import type { AuthNoticeMailer, EmailChange } from './email-change.ts';
import { parseOAuthProvider, type OAuthProvider } from './oauth-types.ts';
import {
  SECRET_BYTES,
  decodeSecret,
  encodeSecret,
  formatVerifyFragment,
  parseChallengeId,
  parseCode,
} from './tokens.ts';

export const SIGN_IN_CODE_PURPOSES: readonly SignInCodePurpose[] = Object.freeze([
  'sign_in',
  'link_identity',
  'step_up',
  'password_reset',
  'email_change',
]);

const PURPOSES: ReadonlySet<unknown> = new Set(SIGN_IN_CODE_PURPOSES);

export function parseSignInCodePurpose(value: unknown): SignInCodePurpose | null {
  return PURPOSES.has(value) ? (value as SignInCodePurpose) : null;
}

export interface SignedIn {
  readonly session: SessionInfo;
  readonly setCookies: readonly CookieSpec[];
  readonly returnTo: string;
  // Mails a security notice when the sign in also linked a provider. Never throws; meant
  // to run after the response.
  readonly send?: () => Promise<void>;
}

// Who may create an account in invite_only mode. The invitations work brings the real one;
// without it nobody new is let in.
export interface PendingInvitations {
  hasPending(emailNormalized: string): Promise<boolean>;
}

export interface Linking {
  readonly provider: 'github' | 'google';
  // Shown in the mail so the person knows which account they are linking.
  readonly account: string;
  // Stored on the challenge, never mailed.
  readonly subject: string;
}

export interface IssueInput {
  readonly purpose: SignInCodePurpose;
  readonly email: string;
  readonly userId: UserId | null;
  readonly linking?: Linking;
  readonly returnTo?: string;
  // False stores the challenge but mails nothing, so the work is the same either way.
  readonly deliver?: boolean;
  // False stores a MAC no typed code can match, so the challenge can never be proved,
  // whatever happens to the address later.
  readonly provable?: boolean;
}

export interface Issued {
  readonly challengeId: string;
  readonly setCookies: readonly CookieSpec[];
  // Never throws; meant to run after the response.
  readonly send: () => Promise<void>;
}

export interface CodeIssuer {
  issue(b: BrowserContext, input: IssueInput): Promise<Result<Issued, AuthError>>;
}

export interface CodeIssuerDeps {
  readonly store: SessionStore;
  readonly logger: AuthLogger;
  readonly mailer: AuthMailer;
  readonly random?: (bytes: number) => Uint8Array;
}

const MAX_ATTEMPTS = 5;
// People type the gap the mail shows; spaces, tabs and no break spaces are dropped and
// nothing else is.
const TYPED_GAPS = /[\u0020\t\u00a0]/g;
const LOGGED_KEY_HEX = 16;

function info(logger: AuthLogger, event: string, fields: Record<string, string>): void {
  try {
    (logger.info ?? logger.warn).call(logger, event, fields);
  } catch {
    // A log line is never worth a failed request.
  }
}

function warn(logger: AuthLogger, event: string, fields: Record<string, string>): void {
  try {
    logger.warn(event, fields);
  } catch {
    // As above.
  }
}

// The browser's pre sign in secret: the one it holds when that is well formed, else a new
// one. Kept when present, so the forms bound to it in other tabs keep working.
function preSecret(
  config: AuthConfig,
  b: BrowserContext,
  random: (n: number) => Uint8Array,
): Buffer {
  return decodeSecret(b.cookies.get(config.cookies.pre)) ?? Buffer.from(random(SECRET_BYTES));
}

const bindingOf = (config: AuthConfig, b: BrowserContext): Buffer | null => {
  const bytes = decodeSecret(b.cookies.get(config.cookies.pre));
  return bytes === null ? null : sha256(bytes);
};

export function createCodeIssuer(config: AuthConfig, deps: CodeIssuerDeps): CodeIssuer {
  const random = deps.random ?? ((n: number) => randomBytes(n));
  return {
    async issue(b, input) {
      const purpose = parseSignInCodePurpose(input.purpose);
      if (purpose === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      // Only a link mail names an account, and a link mail always does.
      if ((purpose === 'link_identity') !== (input.linking !== undefined)) {
        return fail(new AuthError('AUTH_INPUT_INVALID'));
      }
      const to = normalizeAddress(input.email);
      if (to === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      const pre = preSecret(config, b, random);
      const binding = sha256(pre);
      const id = randomUUID();
      const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
      // Codes are 8 digits, so a MAC over 64 hex characters is never one a code produces.
      const macked =
        input.provable === false ? Buffer.from(random(SECRET_BYTES)).toString('hex') : code;
      try {
        await deps.store.auth(async (tx) => {
          // A new code replaces this browser's older ones for the purpose, and nobody else's.
          await tx
            .deleteFrom('email_challenges')
            .where('browser_hash', '=', binding)
            .where('purpose', '=', purpose)
            .where('consumed_at', 'is', null)
            .execute();
          await tx
            .insertInto('email_challenges')
            .values({
              id,
              email_normalized: to,
              purpose,
              user_id: input.userId,
              code_hmac: config.keys.mac('code', [id, purpose, macked]),
              browser_hash: binding,
              pending_provider: input.linking?.provider ?? null,
              pending_subject: input.linking?.subject ?? null,
              return_to: safeReturnTo(input.returnTo, config.appOrigin),
              expires_at: sql<Date>`now() + interval '10 minutes'`,
            })
            .execute();
        });
      } catch (error) {
        return fail(unavailable(error));
      }
      const link = new URL(
        `/sign-in/verify#${formatVerifyFragment({ challengeId: id, code })}`,
        config.appOrigin,
      );
      const linking =
        input.linking === undefined
          ? undefined
          : { provider: input.linking.provider, account: input.linking.account };
      const deliver = input.deliver ?? true;
      const send = async () => {
        if (!deliver) return;
        try {
          await deps.mailer.sendSignInCode(to, code, link, purpose, linking);
        } catch {
          warn(deps.logger, 'auth.sign_in_mail_failed', { purpose });
        }
      };
      return ok({
        challengeId: id,
        setCookies: [
          {
            name: config.cookies.pre,
            value: encodeSecret(pre),
            maxAgeSeconds: PRE_MAX_AGE_SECONDS,
          },
        ],
        send,
      });
    },
  };
}

// What sign in needs of sessions: create one, and the step up check for codes that belong
// to a signed in session.
export interface EmailSessions {
  startSession(
    b: BrowserContext,
    input: { readonly userId: UserId; readonly method: SessionMethod },
  ): Promise<StartedSession>;
  verifyStepUpCode?(
    b: BrowserContext,
    s: SessionInfo,
    input: { readonly challenge: string; readonly code: string },
  ): Promise<Result<SessionInfo, AuthError>>;
}

export interface EmailSignInDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: SessionStore;
  readonly logger: AuthLogger;
  // The notice side is needed only to finish a provider link by code.
  readonly mailer: AuthMailer & Partial<AuthNoticeMailer>;
  readonly sessions?: EmailSessions;
  readonly limiter?: RateLimiter;
  readonly metrics?: AuthMetrics;
  readonly invitations?: PendingInvitations;
  readonly random?: (bytes: number) => Uint8Array;
  // Lets the link in an email change mail finish the change from the verify page.
  readonly emailChange?: Pick<EmailChange, 'completeEmailChange'>;
}

export type LinkVerified =
  | { readonly kind: 'signed_in'; readonly signedIn: SignedIn }
  | { readonly kind: 'stepped_up'; readonly session: SessionInfo }
  // send mails the security notice to the old address; run it after the response.
  | { readonly kind: 'email_changed'; readonly send: () => Promise<void> }
  // A reset code: the page asks for the new password and sends it with the code to
  // completePasswordReset. Nothing is proved or spent yet, and nobody is signed in.
  | { readonly kind: 'choose_password' };

export interface EmailSignIn {
  // One answer for every address: the same cookies and the same shape, mail or not.
  startEmailSignIn(
    b: BrowserContext,
    input: { readonly email: string; readonly returnTo?: string },
  ): Promise<
    Result<
      { readonly setCookies: readonly CookieSpec[]; readonly send: () => Promise<void> },
      AuthError
    >
  >;
  // Without a challenge id (a typed code, scripts off) the browser's newest open challenge
  // is used. Never accepts a step up code.
  verifyEmailCode(
    b: BrowserContext,
    input: { readonly challenge?: string; readonly code: string },
  ): Promise<Result<SignedIn, AuthError>>;
  // The verify link carries no purpose. A step up or email change code goes to the session
  // it belongs to; anything else is a sign in.
  verifyLinkCode(
    b: BrowserContext,
    s: SessionInfo | null,
    input: { readonly challenge: string; readonly code: string },
  ): Promise<Result<LinkVerified, AuthError>>;
}

const PURPOSE = 'sign_in';
// A link code proves the address the same way a sign in code does, then also links the
// provider identity the OAuth callback stored on it.
const LINK = 'link_identity';
const SIGN_IN_PURPOSES = [PURPOSE, LINK] as const;
type SignInPurpose = (typeof SIGN_IN_PURPOSES)[number];

interface Challenge {
  readonly id: string;
  readonly email_normalized: string;
  readonly purpose: string;
  readonly user_id: string | null;
  readonly pending_provider: string | null;
  readonly pending_subject: string | null;
  readonly browser_hash: Buffer;
  readonly return_to: string | null;
  readonly live: boolean;
  readonly consumed: boolean;
}

export function createEmailSignIn(config: AuthConfig, deps: EmailSignInDeps): EmailSignIn {
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
  const sessions: EmailSessions =
    deps.sessions ??
    (db !== undefined && authDb !== undefined
      ? createSessions(config, { db, authDb, logger: deps.logger, mailer: deps.mailer })
      : missing());
  const issuer = createCodeIssuer(config, {
    store,
    logger: deps.logger,
    mailer: deps.mailer,
    ...(deps.random === undefined ? {} : { random: deps.random }),
  });
  const devices = {
    store,
    logger: deps.logger,
    ...(deps.random === undefined ? {} : { random: deps.random }),
  };

  // Outcome codes and hashed bucket keys only: nothing the person typed or was sent.
  function refused(code: AuthErrorCode, address?: string, binding?: Buffer) {
    const fields: Record<string, string> = { outcome: code };
    if (address !== undefined && binding !== undefined) {
      fields['bucket'] = 'code_verify';
      fields['key'] = limiter
        .keyFor('code_verify', [address, binding])
        .toString('hex')
        .slice(0, LOGGED_KEY_HEX);
    }
    info(deps.logger, 'auth.email_code_refused', fields);
    return fail<never>(new AuthError(code));
  }

  async function mayCreate(address: string): Promise<boolean> {
    if (config.signUp === 'open') return true;
    if (config.signUp === 'closed') return false;
    return (await deps.invitations?.hasPending(address)) ?? false;
  }

  // The user the proved address belongs to, made now when sign up allows it.
  async function userFor(
    challenge: Challenge,
  ): Promise<{ readonly userId: UserId; readonly created: boolean } | null> {
    if (challenge.user_id !== null)
      return { userId: idOf('usr', challenge.user_id), created: false };
    const address = challenge.email_normalized;
    const existing = await store.auth((tx) =>
      tx
        .selectFrom('users')
        .select('id')
        .where('email_normalized', '=', address)
        .executeTakeFirst(),
    );
    if (existing !== undefined) return { userId: idOf('usr', existing.id), created: false };
    if (!(await mayCreate(address))) return null;
    const id = newId('usr');
    return store.auth(async (tx) => {
      const made = await tx
        .insertInto('users')
        .values({
          id,
          email: address,
          email_normalized: address,
          email_verified_at: sql<Date>`now()`,
        })
        .onConflict((c) => c.column('email_normalized').doNothing())
        .returning('id')
        .executeTakeFirst();
      if (made !== undefined) return { userId: idOf('usr', made.id), created: true };
      // Someone signed this address up a moment ago; that row is the person.
      const row = await tx
        .selectFrom('users')
        .select('id')
        .where('email_normalized', '=', address)
        .executeTakeFirstOrThrow();
      return { userId: idOf('usr', row.id), created: false };
    });
  }

  // The notice a sign in from a new device owes, if any.
  function deviceSend(
    recorded: RecordedDevice,
    session: SessionInfo,
    method: SessionMethod,
  ): (() => Promise<void>) | undefined {
    const seen = recorded.newDevice;
    if (seen === null) return undefined;
    return newDeviceNotice(config, deps.mailer, deps.logger, {
      to: session.email,
      userId: session.userId,
      method,
      seen,
    });
  }

  // Links the identity a link code carries to the user it was sent for. Null when the code
  // is not a whole link, or the identity or the user's provider slot was taken meanwhile.
  async function linkPending(
    challenge: Challenge,
  ): Promise<{ userId: UserId; provider: OAuthProvider; at: Date } | null> {
    const provider = parseOAuthProvider(challenge.pending_provider);
    const subject = challenge.pending_subject;
    if (challenge.user_id === null || provider === null || subject === null) return null;
    const userId = idOf('usr', challenge.user_id);
    const made = await store.auth((tx) =>
      tx
        .insertInto('identities')
        .values({
          user_id: userId,
          provider,
          provider_subject: subject,
          provider_email_normalized: challenge.email_normalized,
        })
        .onConflict((c) => c.doNothing())
        .returning(['id', 'created_at'])
        .executeTakeFirst(),
    );
    return made === undefined ? null : { userId, provider, at: made.created_at };
  }

  function linkNotice(to: string, provider: OAuthProvider, at: Date) {
    return async () => {
      try {
        const send = deps.mailer.sendSecurityNotice;
        if (send === undefined) throw new Error('no notice mailer');
        await send.call(deps.mailer, to, { kind: 'identity_linked', provider, account: to, at });
      } catch {
        warn(deps.logger, 'auth.identity_notice_failed', { provider });
      }
    };
  }

  async function verify(
    b: BrowserContext,
    input: { readonly challenge?: string; readonly code: string },
  ): Promise<Result<SignedIn, AuthError>> {
    const code = parseCode(input.code.replace(TYPED_GAPS, ''));
    const id = input.challenge === undefined ? null : parseChallengeId(input.challenge);
    if (code === null || (input.challenge !== undefined && id === null)) {
      return refused('AUTH_CODE_INVALID');
    }
    const binding = bindingOf(config, b);
    if (binding === null) return refused('AUTH_CHALLENGE_BINDING');
    try {
      // Read only: the binding is checked before anything is counted, so a code tried from
      // another browser costs the person no attempt.
      const challenge = await store.auth(async (tx) => {
        let query = tx
          .selectFrom('email_challenges')
          .select([
            'id',
            'email_normalized',
            'purpose',
            'user_id',
            'pending_provider',
            'pending_subject',
            'browser_hash',
            'return_to',
            sql<boolean>`expires_at > now() and attempts < ${MAX_ATTEMPTS}`.as('live'),
            sql<boolean>`consumed_at is not null`.as('consumed'),
          ])
          .where('purpose', 'in', SIGN_IN_PURPOSES);
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
      if (challenge === undefined || challenge.consumed) return refused('AUTH_CODE_INVALID');
      if (!constantTimeEqual(challenge.browser_hash, binding)) {
        return refused('AUTH_CHALLENGE_BINDING');
      }
      const address = challenge.email_normalized;
      const purpose: SignInPurpose = challenge.purpose === LINK ? LINK : PURPOSE;
      if (!challenge.live) return refused('AUTH_CHALLENGE_EXPIRED', address, binding);
      try {
        await limiter.reserve('code_verify', [address, binding]);
      } catch (error) {
        if (error instanceof AuthError && error.code === 'AUTH_RATE_LIMITED') {
          refused('AUTH_RATE_LIMITED', address, binding);
        }
        throw error;
      }
      const outcome = await store.auth(async (tx) => {
        // Counted before the compare, in a statement only five can ever pass.
        const row = await tx
          .updateTable('email_challenges')
          .set({ attempts: sql<number>`${sql.ref('attempts')} + 1` })
          .where('id', '=', challenge.id)
          .where('purpose', '=', purpose)
          .where('browser_hash', '=', binding)
          .where('consumed_at', 'is', null)
          .where('attempts', '<', MAX_ATTEMPTS)
          .where('expires_at', '>', sql<Date>`now()`)
          .returning('code_hmac')
          .executeTakeFirst();
        if (row === undefined) return 'AUTH_CHALLENGE_EXPIRED' as const;
        if (!config.keys.verify('code', [challenge.id, purpose, code], row.code_hmac)) {
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
      if (outcome !== 'proved') return refused(outcome, address, binding);
      if (purpose === LINK) {
        // The same answer as a wrong code, so it says nothing about who holds the identity.
        const linked = await linkPending(challenge);
        if (linked === null) return refused('AUTH_CODE_INVALID', address, binding);
        const started = await sessions.startSession(b, {
          userId: linked.userId,
          method: linked.provider,
        });
        const device = await recordDevice(config, devices, b, linked.userId);
        const send = sendBoth(
          linkNotice(address, linked.provider, linked.at),
          deviceSend(device, started.session, linked.provider),
        );
        return ok({
          session: started.session,
          setCookies: [...started.setCookies, ...device.setCookies],
          returnTo: challenge.return_to ?? '/',
          ...(send === undefined ? {} : { send }),
        });
      }
      // Proved: only now may the answer say that sign up is closed.
      const found = await userFor(challenge);
      if (found === null) return refused('AUTH_SIGNUP_CLOSED', address, binding);
      const started = await sessions.startSession(b, { userId: found.userId, method: 'email' });
      const device = await recordDevice(config, devices, b, found.userId);
      // An account made by this very sign in has no device to tell apart from this one.
      const send = found.created ? undefined : deviceSend(device, started.session, 'email');
      return ok({
        session: started.session,
        setCookies: [...started.setCookies, ...device.setCookies],
        returnTo: challenge.return_to ?? '/',
        ...(send === undefined ? {} : { send }),
      });
    } catch (error) {
      return fail(error);
    }
  }

  return Object.freeze({
    async startEmailSignIn(b, input) {
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
        // A browser the person signed in from before has its own allowance, so strangers
        // filling the shared ceiling cannot lock the person out of their own devices.
        if (known && hash !== null) await limiter.reserve('email_send_device', [address, hash]);
        else await limiter.reserve('email_send_address_ceiling', [address]);
        // Asked for every address, known or not: skipping it for known ones would let the
        // lookup's time say which addresses have an account.
        const allowed = await mayCreate(address);
        const deliver = userId !== null || allowed;
        const issued = await issuer.issue(b, {
          purpose: PURPOSE,
          email: address,
          userId,
          ...(input.returnTo === undefined ? {} : { returnTo: input.returnTo }),
          deliver,
        });
        if (!issued.ok) return issued;
        return ok({ setCookies: issued.value.setCookies, send: issued.value.send });
      } catch (error) {
        return fail(error);
      }
    },

    verifyEmailCode: verify,

    async verifyLinkCode(b, s, input) {
      const id = parseChallengeId(input.challenge);
      if (id === null) return refused('AUTH_CODE_INVALID');
      try {
        const row = await store.auth((tx) =>
          tx
            .selectFrom('email_challenges')
            .select(['purpose', 'browser_hash'])
            .where('id', '=', id)
            .executeTakeFirst(),
        );
        if (row?.purpose === 'password_reset') {
          // Read only: the binding is checked here so the page never shows the password
          // step in a browser that could not finish it.
          const binding = bindingOf(config, b);
          if (binding === null || !constantTimeEqual(row.browser_hash, binding)) {
            return refused('AUTH_CHALLENGE_BINDING');
          }
          return ok({ kind: 'choose_password' });
        }
        if (row?.purpose === 'step_up') {
          // A step up code belongs to a session, never to a sign in.
          if (s === null) return refused('AUTH_CHALLENGE_BINDING');
          if (sessions.verifyStepUpCode === undefined) {
            return fail(new AuthError('AUTH_UNAVAILABLE'));
          }
          const stepped = await sessions.verifyStepUpCode(b, s, input);
          return stepped.ok ? ok({ kind: 'stepped_up', session: stepped.value }) : stepped;
        }
        if (row?.purpose === 'email_change') {
          // Moving an address needs the signed in session that asked; it never signs in.
          if (s === null) return refused('AUTH_CHALLENGE_BINDING');
          if (deps.emailChange === undefined) return fail(new AuthError('AUTH_UNAVAILABLE'));
          const changed = await deps.emailChange.completeEmailChange(b, s, input);
          return changed.ok ? ok({ kind: 'email_changed', send: changed.value.send }) : changed;
        }
        const signedIn = await verify(b, input);
        return signedIn.ok ? ok({ kind: 'signed_in', signedIn: signedIn.value }) : signedIn;
      } catch (error) {
        return fail(error);
      }
    },
  } satisfies EmailSignIn);
}

function missing(): never {
  throw new TypeError('createEmailSignIn needs db and authDb, or a store, limiter and sessions');
}
