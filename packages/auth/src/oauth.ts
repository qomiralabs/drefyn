import type { Result } from '@drefyn/address';
import { DbError, newId, withAuth, withUser, type AuthDatabase, type Database } from '@drefyn/db';
import { idOf, type UserId } from '@drefyn/tenancy';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { normalizeAddress } from './address.ts';
import { rateKeyForIp } from './client-ip.ts';
import type { AuthConfig } from './config.ts';
import { sessionCookieValue, type BrowserContext, type CookieSpec } from './cookies.ts';
import { newDeviceNotice, recordDevice } from './devices.ts';
import type { AuthNoticeMailer } from './email-change.ts';
import { createCodeIssuer, heldInvitation, type PendingInvitations } from './email-sign-in.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import { constantTimeEqual, sha256 } from './keys.ts';
import type { OAuthTransport } from './oauth/fetch.ts';
import {
  createProviders,
  redirectUriFor,
  type Provider,
  type ProviderProfile,
} from './oauth/providers.ts';
import {
  parseOAuthProvider,
  parseOAuthPurpose,
  type OAuthProvider,
  type OAuthPurpose,
} from './oauth-types.ts';
import { createRateLimiter, type AuthLogger, type RateLimiter } from './rate-limiter.ts';
import { safeReturnTo } from './return-to.ts';
import {
  fail,
  idFields,
  ok,
  quietInfo,
  quietWarn,
  type SessionInfo,
  type SessionStore,
} from './session-support.ts';
import { createSessions, type Sessions } from './sessions.ts';
import { recordStepUp, type AuthMailer } from './step-up.ts';
import { SECRET_BYTES, decodeSecret, encodeSecret } from './tokens.ts';

export type { OAuthProvider, OAuthPurpose } from './oauth-types.ts';
export type { OAuthTransport } from './oauth/fetch.ts';

// What OAuth needs of sessions: make one after a sign in, find the browser's own for link
// and step up, and the recent sign in check linking requires.
export type OAuthSessions = Pick<Sessions, 'startSession' | 'resolveSession' | 'requireRecentAuth'>;

export interface OAuthDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: SessionStore;
  readonly logger: AuthLogger;
  readonly mailer: AuthMailer & AuthNoticeMailer;
  readonly sessions?: OAuthSessions;
  readonly limiter?: RateLimiter;
  readonly invitations?: PendingInvitations;
  // Tests only: answers the provider hosts in process. Auth builds the guarded fetch
  // itself, so the app never holds a raw fetch for OAuth.
  readonly oauthTransport?: OAuthTransport;
  readonly random?: (bytes: number) => Uint8Array;
}

export type OAuthCompleted =
  | {
      readonly kind: 'signed_in';
      readonly session: SessionInfo;
      readonly setCookies: readonly CookieSpec[];
      readonly returnTo: string;
      // Mails the new device notice when one is owed. Never throws; run it after the response.
      readonly send?: () => Promise<void>;
    }
  | {
      readonly kind: 'stepped_up';
      readonly session: SessionInfo;
      readonly setCookies: readonly CookieSpec[];
      readonly returnTo: string;
    }
  | {
      readonly kind: 'linked';
      readonly session: SessionInfo;
      readonly setCookies: readonly CookieSpec[];
      readonly returnTo: string;
      // The security notice; never throws, meant to run after the response.
      readonly send: () => Promise<void>;
    }
  // The provider's verified address belongs to an account the identity is not linked to.
  // A code goes to that address; send mails it, after the response.
  | {
      readonly kind: 'link_pending';
      readonly setCookies: readonly CookieSpec[];
      readonly send: () => Promise<void>;
    };

export interface OAuth {
  startOAuth(
    b: BrowserContext,
    input: {
      readonly provider: OAuthProvider;
      readonly purpose: OAuthPurpose;
      readonly returnTo?: string;
      readonly session?: SessionInfo;
    },
  ): Promise<
    Result<{ readonly redirectTo: URL; readonly setCookies: readonly CookieSpec[] }, AuthError>
  >;
  completeOAuth(
    b: BrowserContext,
    input: { readonly provider: OAuthProvider; readonly query: URLSearchParams },
  ): Promise<Result<OAuthCompleted, AuthError>>;
  // Needs a sign in within 15 minutes, and never removes the last way to sign in.
  unlinkIdentity(
    s: SessionInfo,
    input: { readonly provider: OAuthProvider },
  ): Promise<Result<{ readonly send: () => Promise<void> }, AuthError>>;
}

const STATE_MAX_AGE_SECONDS = 10 * 60;
const PRE_MAX_AGE_SECONDS = 15 * 60;
// Google's auth_time must be this recent for a step up.
const STEP_UP_SECONDS = 5 * 60;

// The table names the link purpose after the email challenge it leads to.
const STORED_PURPOSE = { sign_in: 'sign_in', link: 'link_identity', step_up: 'step_up' } as const;

class Refused extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

interface StateRow {
  readonly provider: string;
  readonly purpose: string;
  readonly code_verifier: string;
  readonly nonce: string | null;
  readonly browser_hash: Buffer;
  readonly return_to: string | null;
  readonly link_user_id: string | null;
  readonly live: boolean;
}

export function createOAuth(config: AuthConfig, deps: OAuthDeps): OAuth {
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
  const sessions: OAuthSessions =
    deps.sessions ??
    (db !== undefined && authDb !== undefined
      ? createSessions(config, { db, authDb, logger: deps.logger, mailer: deps.mailer })
      : missing());
  const random = deps.random ?? ((n: number) => randomBytes(n));
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
  const providers = createProviders(config, deps.logger, deps.oauthTransport);
  const clear = (name: string): CookieSpec => ({ name, value: '', maxAgeSeconds: 0 });

  const providerFor = (name: OAuthProvider): Provider => {
    const provider = providers[name];
    if (provider === null) throw new Refused('AUTH_OAUTH_DISABLED');
    return provider;
  };

  // The outcome code and provider only: never an address, a code, a state or a body.
  function refused<T>(provider: string, error: unknown): Result<T, AuthError> {
    const code = error instanceof Refused ? error.code : null;
    const failure = code === null ? error : new AuthError(code);
    const outcome = failure instanceof AuthError ? failure.code : 'AUTH_UNAVAILABLE';
    quietInfo(deps.logger, 'auth.oauth_refused', {
      provider: parseOAuthProvider(provider) ?? 'other',
      outcome,
    });
    return fail(failure);
  }

  async function mayCreate(b: BrowserContext, address: string): Promise<boolean> {
    if (config.signUp === 'open') return true;
    if (config.signUp === 'closed') return false;
    return (await deps.invitations?.allowsSignUp(heldInvitation(config, b), address)) ?? false;
  }

  // Another way this user could step up. Email counts unless it is off: in auto mode only
  // the app knows, so it is assumed on and GitHub step up stays refused.
  async function hasOtherStepUp(userId: UserId): Promise<boolean> {
    if (config.email !== 'off') return true;
    return store.user(userId, async (tx) => {
      const password = config.passwords.enabled
        ? await tx
            .selectFrom('password_credentials')
            .select('user_id')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .executeTakeFirst()
        : undefined;
      const google = await tx
        .selectFrom('identities')
        .select('id')
        .where('user_id', '=', sql<string>`app.current_user_id()`)
        .where('provider', '=', 'google')
        .executeTakeFirst();
      return password !== undefined || google !== undefined;
    });
  }

  async function identityOwner(provider: OAuthProvider, subject: string): Promise<UserId | null> {
    const row = await store.auth((tx) =>
      tx
        .selectFrom('identities')
        .select('user_id')
        .where('provider', '=', provider)
        .where('provider_subject', '=', subject)
        .executeTakeFirst(),
    );
    return row === undefined ? null : idOf('usr', row.user_id);
  }

  // The session this browser holds, which must be the one that started the flow.
  async function sessionOf(b: BrowserContext, userId: string | null): Promise<SessionInfo> {
    const session = await sessions.resolveSession(sessionCookieValue(config, b.cookies));
    if (session === null || userId === null || session.userId !== userId) {
      throw new Refused('AUTH_SESSION_INVALID');
    }
    return session;
  }

  async function signIn(
    b: BrowserContext,
    provider: OAuthProvider,
    userId: UserId,
    returnTo: string,
    created = false,
  ): Promise<OAuthCompleted> {
    const started = await sessions.startSession(b, { userId, method: provider });
    const device = await recordDevice(config, devices, b, userId);
    const seen = device.newDevice;
    // An account made by this very sign in has no device to tell apart from this one.
    const owed = seen !== null && !created;
    return {
      kind: 'signed_in',
      session: started.session,
      setCookies: [...started.setCookies, ...device.setCookies],
      returnTo,
      ...(owed
        ? {
            send: newDeviceNotice(config, deps.mailer, deps.logger, {
              to: started.session.email,
              userId,
              method: provider,
              seen,
            }),
          }
        : {}),
    };
  }

  // A user and identity made together, or neither. Null when the address was signed up a
  // moment ago by someone else, which makes this a link case.
  async function createUser(
    provider: OAuthProvider,
    profile: ProviderProfile,
    address: string,
  ): Promise<UserId | null> {
    const id = newId('usr');
    try {
      return await store.auth(async (tx) => {
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
        if (made === undefined) return null;
        const linked = await tx
          .insertInto('identities')
          .values({
            user_id: id,
            provider,
            provider_subject: profile.subject,
            provider_email_normalized: address,
          })
          .onConflict((c) => c.doNothing())
          .returning('id')
          .executeTakeFirst();
        // The identity was made by a parallel callback: roll the user back, start again.
        if (linked === undefined) throw new Refused('AUTH_OAUTH_STATE_INVALID');
        return id;
      });
    } catch (error) {
      if (error instanceof DbError && error.code === 'DB_UNIQUE_VIOLATION') {
        throw new Refused('AUTH_OAUTH_STATE_INVALID');
      }
      throw error;
    }
  }

  async function linkPending(
    b: BrowserContext,
    provider: OAuthProvider,
    profile: ProviderProfile,
    address: string,
    userId: UserId,
    returnTo: string,
  ): Promise<OAuthCompleted> {
    const ipKey = rateKeyForIp(b.ip);
    await limiter.reserve('email_send', [address, ipKey]);
    await limiter.reserve('email_send_ip', [ipKey]);
    const issued = await issuer.issue(b, {
      purpose: 'link_identity',
      email: address,
      userId,
      linking: { provider, account: profile.account, subject: profile.subject },
      returnTo,
    });
    if (!issued.ok) throw issued.error;
    return {
      kind: 'link_pending',
      setCookies: [...issued.value.setCookies, clear(config.cookies.oauth)],
      send: issued.value.send,
    };
  }

  async function signInFlow(
    b: BrowserContext,
    provider: OAuthProvider,
    profile: ProviderProfile,
    returnTo: string,
  ): Promise<OAuthCompleted> {
    const owner = await identityOwner(provider, profile.subject);
    if (owner !== null) return signIn(b, provider, owner, returnTo);
    if (profile.email === null) throw new Refused('AUTH_OAUTH_EMAIL_UNVERIFIED');
    const address = normalizeAddress(profile.email);
    if (address === null) throw new Refused('AUTH_INPUT_INVALID');
    const existing = await store.auth((tx) =>
      tx
        .selectFrom('users')
        .select('id')
        .where('email_normalized', '=', address)
        .executeTakeFirst(),
    );
    // Never linked by a matching address alone: the address has to prove itself by code.
    if (existing !== undefined) {
      return linkPending(b, provider, profile, address, idOf('usr', existing.id), returnTo);
    }
    if (!(await mayCreate(b, address))) throw new Refused('AUTH_SIGNUP_CLOSED');
    const made = await createUser(provider, profile, address);
    if (made === null) {
      const raced = await store.auth((tx) =>
        tx
          .selectFrom('users')
          .select('id')
          .where('email_normalized', '=', address)
          .executeTakeFirstOrThrow(),
      );
      return linkPending(b, provider, profile, address, idOf('usr', raced.id), returnTo);
    }
    return signIn(b, provider, made, returnTo, true);
  }

  function identityNotice(
    to: string,
    kind: 'identity_linked' | 'identity_unlinked',
    provider: OAuthProvider,
    account: string,
    at: Date,
    userId: UserId,
  ) {
    return async () => {
      try {
        await deps.mailer.sendSecurityNotice(to, { kind, provider, account, at });
      } catch {
        quietWarn(deps.logger, 'auth.identity_notice_failed', {
          provider,
          ...idFields({ userId: ['usr', userId] }),
        });
      }
    };
  }

  async function linkFlow(
    b: BrowserContext,
    provider: OAuthProvider,
    profile: ProviderProfile,
    row: StateRow,
    returnTo: string,
  ): Promise<OAuthCompleted> {
    const session = await sessionOf(b, row.link_user_id);
    const recent = await sessions.requireRecentAuth(session);
    if (!recent.ok) throw recent.error;
    const done = (send: () => Promise<void>): OAuthCompleted => ({
      kind: 'linked',
      session,
      setCookies: [clear(config.cookies.oauth)],
      returnTo,
      send,
    });
    const owner = await identityOwner(provider, profile.subject);
    if (owner === session.userId) return done(() => Promise.resolve());
    if (owner !== null) throw new Refused('AUTH_FORBIDDEN');
    if (profile.email === null) throw new Refused('AUTH_OAUTH_EMAIL_UNVERIFIED');
    const address = normalizeAddress(profile.email);
    if (address === null) throw new Refused('AUTH_INPUT_INVALID');
    const made = await store.auth((tx) =>
      tx
        .insertInto('identities')
        .values({
          user_id: session.userId,
          provider,
          provider_subject: profile.subject,
          provider_email_normalized: address,
        })
        .onConflict((c) => c.doNothing())
        .returning(['id', 'created_at'])
        .executeTakeFirst(),
    );
    // Someone took the identity meanwhile, or this user already has one of the provider.
    if (made === undefined) throw new Refused('AUTH_FORBIDDEN');
    quietInfo(deps.logger, 'auth.identity_linked', {
      provider,
      ...idFields({ userId: ['usr', session.userId] }),
    });
    return done(
      identityNotice(
        session.email,
        'identity_linked',
        provider,
        address,
        made.created_at,
        session.userId,
      ),
    );
  }

  async function stepUpFlow(
    b: BrowserContext,
    provider: OAuthProvider,
    profile: ProviderProfile,
    row: StateRow,
    returnTo: string,
  ): Promise<OAuthCompleted> {
    const session = await sessionOf(b, row.link_user_id);
    const owner = await identityOwner(provider, profile.subject);
    if (owner !== session.userId) throw new Refused('AUTH_STEP_UP_IDENTITY_MISMATCH');
    let method: 'google' | 'github_session';
    if (provider === 'google') {
      // max_age=0 asked Google for a new sign in; this is what proves it happened.
      const now = Math.floor(Date.now() / 1000);
      if (profile.authTime === null || now - profile.authTime > STEP_UP_SECONDS) {
        throw new Refused('AUTH_RECENT_AUTH_REQUIRED');
      }
      method = 'google';
    } else {
      // GitHub cannot be made to ask again, so it proves only a live GitHub session.
      if (await hasOtherStepUp(session.userId)) throw new Refused('AUTH_FORBIDDEN');
      method = 'github_session';
    }
    const stepped = await recordStepUp(store, session, method);
    return {
      kind: 'stepped_up',
      session: stepped,
      setCookies: [clear(config.cookies.oauth)],
      returnTo,
    };
  }

  // Deletes the state the browser brought, once: whatever happens next it cannot be used
  // again. Refuses unless the query, the cookie, the provider and the browser all agree.
  async function takeState(b: BrowserContext, provider: OAuthProvider, query: URLSearchParams) {
    const state = query.get('state');
    const cookie = b.cookies.get(config.cookies.oauth);
    if (state === null || cookie === undefined || state.length === 0) {
      throw new Refused('AUTH_OAUTH_STATE_INVALID');
    }
    // Compared as hashes, so the lengths always match and the compare is constant time.
    if (!constantTimeEqual(sha256(Buffer.from(state)), sha256(Buffer.from(cookie)))) {
      throw new Refused('AUTH_OAUTH_STATE_INVALID');
    }
    const pre = decodeSecret(b.cookies.get(config.cookies.pre));
    if (pre === null) throw new Refused('AUTH_OAUTH_STATE_INVALID');
    const row: StateRow | undefined = await store.auth((tx) =>
      tx
        .deleteFrom('oauth_states')
        .where('state_hash', '=', sha256(Buffer.from(state)))
        .returning([
          'provider',
          'purpose',
          'code_verifier',
          'nonce',
          'browser_hash',
          'return_to',
          'link_user_id',
          sql<boolean>`expires_at > now()`.as('live'),
        ])
        .executeTakeFirst(),
    );
    if (row?.provider !== provider || !row.live) {
      throw new Refused('AUTH_OAUTH_STATE_INVALID');
    }
    if (!constantTimeEqual(row.browser_hash, sha256(pre))) {
      throw new Refused('AUTH_OAUTH_STATE_INVALID');
    }
    return { state, row };
  }

  return Object.freeze({
    async startOAuth(b, input) {
      const name = parseOAuthProvider(input.provider);
      const purpose = parseOAuthPurpose(input.purpose);
      if (name === null || purpose === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      try {
        const provider = providerFor(name);
        const session = input.session;
        if (purpose !== 'sign_in' && session === undefined)
          throw new Refused('AUTH_SESSION_INVALID');
        if (purpose === 'link' && session !== undefined) {
          const recent = await sessions.requireRecentAuth(session);
          if (!recent.ok) throw recent.error;
        }
        if (purpose === 'step_up' && name === 'github' && session !== undefined) {
          if (await hasOtherStepUp(session.userId)) throw new Refused('AUTH_FORBIDDEN');
        }
        await limiter.reserve('oauth_start', [rateKeyForIp(b.ip)]);
        const state = encodeSecret(random(SECRET_BYTES));
        const verifier = encodeSecret(random(SECRET_BYTES));
        const nonce = name === 'google' ? encodeSecret(random(SECRET_BYTES)) : null;
        const pre =
          decodeSecret(b.cookies.get(config.cookies.pre)) ?? Buffer.from(random(SECRET_BYTES));
        await store.auth((tx) =>
          tx
            .insertInto('oauth_states')
            .values({
              state_hash: sha256(Buffer.from(state)),
              provider: name,
              purpose: STORED_PURPOSE[purpose],
              code_verifier: verifier,
              nonce,
              browser_hash: sha256(pre),
              return_to: safeReturnTo(input.returnTo, config.appOrigin),
              link_user_id: purpose === 'sign_in' ? null : (session?.userId ?? null),
              expires_at: sql<Date>`now() + interval '10 minutes'`,
            })
            .execute(),
        );
        const redirectTo = provider.authorizationUrl({
          redirectUri: redirectUriFor(config, name),
          state,
          codeChallenge: s256(verifier),
          nonce,
          stepUp: purpose === 'step_up',
        });
        return ok({
          redirectTo,
          setCookies: [
            {
              name: config.cookies.pre,
              value: encodeSecret(pre),
              maxAgeSeconds: PRE_MAX_AGE_SECONDS,
            },
            { name: config.cookies.oauth, value: state, maxAgeSeconds: STATE_MAX_AGE_SECONDS },
          ],
        });
      } catch (error) {
        return refused(name, error);
      }
    },

    async completeOAuth(b, input) {
      const name = parseOAuthProvider(input.provider);
      if (name === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      try {
        const provider = providerFor(name);
        const { state, row } = await takeState(b, name, input.query);
        // The callback URL is rebuilt on the configured origin; only the query comes from
        // the request.
        const callback = new URL(redirectUriFor(config, name));
        for (const [key, value] of input.query) callback.searchParams.append(key, value);
        const profile = await provider.complete({
          callback,
          state,
          codeVerifier: row.code_verifier,
          nonce: row.nonce,
        });
        const returnTo = row.return_to ?? '/';
        if (row.purpose === 'link_identity')
          return ok(await linkFlow(b, name, profile, row, returnTo));
        if (row.purpose === 'step_up') return ok(await stepUpFlow(b, name, profile, row, returnTo));
        return ok(await signInFlow(b, name, profile, returnTo));
      } catch (error) {
        return refused(name, error);
      }
    },

    async unlinkIdentity(s, input) {
      const name = parseOAuthProvider(input.provider);
      if (name === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      try {
        const recent = await sessions.requireRecentAuth(s);
        if (!recent.ok) throw recent.error;
        const removed = await store.user(s.userId, async (tx) => {
          // The person's row first, as password removal does, so the two cannot both pass
          // the check below and leave no way in.
          await tx
            .selectFrom('users')
            .select('id')
            .where('id', '=', s.userId)
            .forNoKeyUpdate()
            .executeTakeFirst();
          const rows = await tx
            .selectFrom('identities')
            .select(['id', 'provider', 'provider_email_normalized'])
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .execute();
          const target = rows.find((r) => r.provider === name);
          if (target === undefined) throw new Refused('AUTH_NOT_FOUND');
          const password = config.passwords.enabled
            ? await tx
                .selectFrom('password_credentials')
                .select('user_id')
                .where('user_id', '=', sql<string>`app.current_user_id()`)
                .executeTakeFirst()
            : undefined;
          const others = rows.length > 1 || password !== undefined || config.email !== 'off';
          // With email off, the last identity is the only way back in.
          if (!others) throw new Refused('AUTH_FORBIDDEN');
          const gone = await tx
            .deleteFrom('identities')
            .where('id', '=', target.id)
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .returning('id')
            .executeTakeFirst();
          if (gone === undefined) throw new Refused('AUTH_NOT_FOUND');
          return { account: target.provider_email_normalized, at: new Date() };
        });
        quietInfo(deps.logger, 'auth.identity_unlinked', {
          provider: name,
          ...idFields({ userId: ['usr', s.userId] }),
        });
        return ok({
          send: identityNotice(
            s.email,
            'identity_unlinked',
            name,
            removed.account,
            removed.at,
            s.userId,
          ),
        });
      } catch (error) {
        return refused(name, error);
      }
    },
  } satisfies OAuth);
}

function missing(): never {
  throw new TypeError('createOAuth needs db and authDb, or a store, limiter and sessions');
}
