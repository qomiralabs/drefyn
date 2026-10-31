import type { Result } from '@drefyn/address';
import { withAuth, withUser, type AuthDatabase, type Database, type UserSchema } from '@drefyn/db';
import { idOf, type OrganizationId, type UserId } from '@drefyn/tenancy';
import { randomBytes } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import { grantAccess, type AccessResult } from './access.ts';
import type { AuthConfig } from './config.ts';
import { sessionCookieValue, type BrowserContext, type CookieSpec } from './cookies.ts';
import { AuthError } from './errors.ts';
import { constantTimeEqual, sha256 } from './keys.ts';
import { isSlugShape } from './organization-rules.ts';
import { createRateLimiter, type AuthLogger, type RateLimiter } from './rate-limiter.ts';
import {
  asId,
  fail,
  idFields,
  ok,
  quietWarn,
  unavailable,
  type SessionId,
  type SessionInfo,
  type SessionMethod,
  type SessionStore,
  type StepUpMethod,
} from './session-support.ts';
import { stepUps, type AuthMailer, type PasswordVerifier, type StepUps } from './step-up.ts';

export type {
  SessionId,
  SessionInfo,
  SessionMethod,
  SessionStore,
  StepUpMethod,
} from './session-support.ts';
import {
  SECRET_BYTES,
  formatSessionToken,
  parseSessionToken,
  type SessionToken,
} from './tokens.ts';

// What the sessions page shows. No secret hash and no IP: neither is stored for display.
export interface SessionSummary {
  readonly sessionId: SessionId;
  readonly method: SessionMethod;
  readonly userAgent: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly current: boolean;
}

// The guard's session half. touchDue tells the caller to run touchSession after the
// response, so the page itself never waits on a write.
export interface ResolvedSession {
  readonly session: SessionInfo;
  readonly touchDue: boolean;
}

export interface SessionRef {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  // Only for the failure log; the write itself runs under the user alone.
  readonly organizationId?: OrganizationId;
}

export interface StartedSession {
  readonly session: SessionInfo;
  readonly setCookies: readonly CookieSpec[];
}

export interface SessionsDeps {
  readonly db: Database;
  readonly authDb: AuthDatabase;
  readonly logger: AuthLogger;
  readonly mailer?: AuthMailer;
  // Brought by the passwords work; without it password step up is refused.
  readonly passwords?: PasswordVerifier;
  readonly limiter?: RateLimiter;
  readonly random?: (bytes: number) => Uint8Array;
  readonly store?: SessionStore;
}

export interface Sessions extends StepUps {
  // Creates the row for a sign in that was just proved. Any session the browser already
  // holds is deleted first, once its cookie proves it, whoever it belongs to.
  startSession(
    b: BrowserContext,
    input: { readonly userId: UserId; readonly method: SessionMethod },
  ): Promise<StartedSession>;
  resolve(cookie: string | undefined): Promise<ResolvedSession | null>;
  resolveSession(cookie: string | undefined): Promise<SessionInfo | null>;
  // The guard's one call. Read only: a due touch is reported, never written here.
  resolveAccess(cookie: string | undefined, slug: string): Promise<AccessResult>;
  touchSession(ref: SessionRef): Promise<void>;
  signOut(s: SessionInfo): Promise<readonly CookieSpec[]>;
  signOutEverywhere(s: SessionInfo): Promise<number>;
  listSessions(s: SessionInfo): Promise<readonly SessionSummary[]>;
  revokeSession(s: SessionInfo, id: SessionId): Promise<Result<void, AuthError>>;
}

const METHODS: ReadonlySet<string> = new Set(['email', 'password', 'github', 'google', 'cli_link']);
const STEP_UP_METHODS: ReadonlySet<string> = new Set([
  'email',
  'password',
  'google',
  'github_session',
]);
const USER_AGENT_MAX = 256;
const DAY_SECONDS = 86_400;
// Compared against on a miss, so a missing row costs the same compare as a wrong secret.
const DUMMY_HASH = Buffer.alloc(32);

// Thrown inside a transaction to roll it back before anything else is sent. Not a pg
// error, so the db layer passes it through untouched.
class Refused extends Error {}
const REFUSED = new Refused('refused');

const SIGNED_OUT: AccessResult = Object.freeze({ kind: 'signed_out' });
const NOT_MEMBER: AccessResult = Object.freeze({ kind: 'not_member' });

const method = (value: string): SessionMethod => {
  if (!METHODS.has(value)) throw new Error('stored session method is unknown');
  return value as SessionMethod;
};

interface Proved {
  readonly id: string;
  readonly method: string;
  readonly step_up_method: string | null;
  readonly authenticated_at: Date;
  readonly expires_at: Date;
  readonly live: boolean;
  readonly touch_due: boolean;
}

// The first statement of every path that holds a cookie: the session row alone, by id. The
// compare runs here in process, before the caller may send anything else; null means the
// cookie proved nothing. Liveness comes back as a flag so a caller can still clean up an
// expired row it proved.
async function prove(
  tx: Transaction<UserSchema>,
  token: SessionToken,
  idleDays: number,
): Promise<Proved | null> {
  const row = await tx
    .selectFrom('sessions')
    .select([
      'id',
      'user_id',
      'secret_hash',
      'method',
      'step_up_method',
      'authenticated_at',
      'expires_at',
      // Database time only, so a skewed app clock cannot stretch or cut a session.
      sql<boolean>`expires_at > now() and last_seen_at > now() - make_interval(days => ${idleDays})`.as(
        'live',
      ),
      sql<boolean>`last_seen_at < now() - interval '1 hour'`.as('touch_due'),
    ])
    .where('id', '=', token.sessionId)
    .executeTakeFirst();
  const matched = constantTimeEqual(sha256(token.secret), row?.secret_hash ?? DUMMY_HASH);
  if (row === undefined || !matched || row.user_id !== token.userId) return null;
  return row;
}

function info(row: Proved, token: SessionToken, email: string): SessionInfo {
  const base = {
    sessionId: token.sessionId,
    userId: token.userId,
    email,
    authenticatedAt: row.authenticated_at,
    expiresAt: row.expires_at,
    method: method(row.method),
  };
  const stepUp = row.step_up_method;
  if (stepUp === null) return base;
  if (!STEP_UP_METHODS.has(stepUp)) throw new Error('stored step up method is unknown');
  return { ...base, stepUpMethod: stepUp as StepUpMethod };
}

// Code points, not UTF-16 units, so a cut never splits a surrogate pair and the database's
// char_length check agrees.
function userAgent(value: string): string | null {
  const chars = Array.from(value);
  if (chars.length === 0) return null;
  return chars.slice(0, USER_AGENT_MAX).join('');
}

export function createSessions(config: AuthConfig, deps: SessionsDeps): Sessions {
  const store: SessionStore = deps.store ?? {
    user: (userId, work) => withUser(deps.db, { userId }, work),
    auth: (work) => withAuth(deps.authDb, work),
  };
  const limiter =
    deps.limiter ??
    createRateLimiter({
      db: deps.authDb,
      keys: config.keys,
      limits: config.rateLimits,
      logger: deps.logger,
    });
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const { idleDays, absoluteDays } = config.session;
  const clear = (name: string): CookieSpec => ({ name, value: '', maxAgeSeconds: 0 });

  async function resolve(cookie: string | undefined): Promise<ResolvedSession | null> {
    const token = parseSessionToken(cookie);
    if (token === null) return null;
    try {
      return await store.user(token.userId, async (tx) => {
        const row = await prove(tx, token, idleDays);
        if (!row?.live) throw REFUSED;
        const user = await tx
          .selectFrom('users')
          .select('email')
          .where('id', '=', token.userId)
          .executeTakeFirst();
        if (user === undefined) throw REFUSED;
        return { session: info(row, token, user.email), touchDue: row.touch_due };
      });
    } catch (error) {
      if (error === REFUSED) return null;
      throw unavailable(error);
    }
  }

  // Deletes the row a browser's cookie proves. A cookie that proves nothing leaves every
  // row alone, so a forged cookie cannot sign anyone out.
  async function retire(token: SessionToken): Promise<void> {
    try {
      await store.user(token.userId, async (tx) => {
        if ((await prove(tx, token, idleDays)) === null) throw REFUSED;
        await tx.deleteFrom('sessions').where('id', '=', token.sessionId).execute();
      });
    } catch (error) {
      if (error !== REFUSED) throw unavailable(error);
    }
  }

  const steps = stepUps(config, {
    store,
    limiter,
    logger: deps.logger,
    ...(deps.mailer === undefined ? {} : { mailer: deps.mailer }),
    ...(deps.passwords === undefined ? {} : { passwords: deps.passwords }),
  });

  return Object.freeze({
    ...steps,

    async startSession(b, input) {
      const old = parseSessionToken(sessionCookieValue(config, b.cookies));
      if (old !== null) await retire(old);
      const secret = random(SECRET_BYTES);
      try {
        const session = await store.user(input.userId, async (tx) => {
          const row = await tx
            .insertInto('sessions')
            .values({
              user_id: input.userId,
              secret_hash: sha256(secret),
              method: input.method,
              authenticated_at: sql<Date>`now()`,
              last_seen_at: sql<Date>`now()`,
              expires_at: sql<Date>`now() + make_interval(days => ${absoluteDays})`,
              user_agent: userAgent(b.userAgent),
            })
            .returning(['id', 'authenticated_at', 'expires_at'])
            .executeTakeFirstOrThrow();
          const user = await tx
            .selectFrom('users')
            .select('email')
            .where('id', '=', input.userId)
            .executeTakeFirstOrThrow();
          return {
            sessionId: idOf('ses', row.id),
            userId: input.userId,
            email: user.email,
            authenticatedAt: row.authenticated_at,
            expiresAt: row.expires_at,
            method: input.method,
          } satisfies SessionInfo;
        });
        const value = formatSessionToken({
          userId: input.userId,
          sessionId: session.sessionId,
          secret,
        });
        return {
          session,
          // The pre sign in cookies go, so nothing chosen before sign in outlives it.
          setCookies: [
            { name: config.cookies.session, value, maxAgeSeconds: absoluteDays * DAY_SECONDS },
            clear(config.cookies.pre),
            clear(config.cookies.oauth),
          ],
        };
      } catch (error) {
        throw unavailable(error);
      }
    },

    resolve,

    async resolveSession(cookie) {
      return (await resolve(cookie))?.session ?? null;
    },

    async resolveAccess(cookie, slug) {
      const token = parseSessionToken(cookie);
      if (token === null) return SIGNED_OUT;
      try {
        return await store.user(token.userId, async (tx) => {
          const row = await prove(tx, token, idleDays);
          if (!row?.live) throw REFUSED;
          // A slug that cannot exist needs no read; it answers like an unknown one.
          if (!isSlugShape(slug)) return NOT_MEMBER;
          // Only after the proof: the slug, the organization and the person's own
          // membership, each readable here only through that membership.
          const member = await tx
            .selectFrom('organization_slugs as s')
            .innerJoin('organizations as o', 'o.organization_id', 's.organization_id')
            .innerJoin('memberships as m', (join) =>
              join
                .onRef('m.organization_id', '=', 's.organization_id')
                .on('m.user_id', '=', sql<string>`app.current_user_id()`),
            )
            .select(['s.organization_id', 'm.role', 'm.default_project_role', 'o.plan_tier'])
            .where('s.slug', '=', slug)
            .executeTakeFirst();
          if (member === undefined) return NOT_MEMBER;
          const access = grantAccess({
            organizationId: idOf('org', member.organization_id),
            userId: token.userId,
            sessionId: token.sessionId,
            role: member.role,
            defaultProjectRole: member.default_project_role,
            tier: member.plan_tier,
            authenticatedAt: row.authenticated_at,
          });
          return { kind: 'ok', access, touchDue: row.touch_due } as const;
        });
      } catch (error) {
        if (error === REFUSED) return SIGNED_OUT;
        throw unavailable(error);
      }
    },

    async touchSession(ref) {
      try {
        if (asId('usr', ref.userId) === null || asId('ses', ref.sessionId) === null) {
          throw new Error('not an id');
        }
        // The guard on last_seen_at makes a second touch in the hour a no op, and a revoked
        // row matches nothing, so nothing is ever brought back.
        await store.user(ref.userId, (tx) =>
          tx
            .updateTable('sessions')
            .set({ last_seen_at: sql<Date>`now()` })
            .where('id', '=', ref.sessionId)
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .where('last_seen_at', '<', sql<Date>`now() - interval '1 hour'`)
            .execute(),
        );
      } catch {
        quietWarn(
          deps.logger,
          'auth.session_touch_failed',
          idFields({
            organizationId: ['org', ref.organizationId],
            userId: ['usr', ref.userId],
            sessionId: ['ses', ref.sessionId],
          }),
        );
      }
    },

    async signOut(s) {
      try {
        await store.user(s.userId, (tx) =>
          tx
            .deleteFrom('sessions')
            .where('id', '=', s.sessionId)
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .execute(),
        );
      } catch (error) {
        throw unavailable(error);
      }
      return [clear(config.cookies.session)];
    },

    async signOutEverywhere(s) {
      try {
        const rows = await store.user(s.userId, (tx) =>
          tx
            .deleteFrom('sessions')
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .returning('id')
            .execute(),
        );
        return rows.length;
      } catch (error) {
        throw unavailable(error);
      }
    },

    async listSessions(s) {
      try {
        const rows = await store.user(s.userId, (tx) =>
          tx
            .selectFrom('sessions')
            .select(['id', 'method', 'user_agent', 'created_at', 'last_seen_at'])
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .where('expires_at', '>', sql<Date>`now()`)
            .where('last_seen_at', '>', sql<Date>`now() - make_interval(days => ${idleDays})`)
            .orderBy('last_seen_at', 'desc')
            .execute(),
        );
        return rows.map((row) => ({
          sessionId: idOf('ses', row.id),
          method: method(row.method),
          userAgent: row.user_agent,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          current: row.id === s.sessionId,
        }));
      } catch (error) {
        throw unavailable(error);
      }
    },

    async revokeSession(s, id) {
      if (asId('ses', id) === null) return fail(new AuthError('AUTH_NOT_FOUND'));
      try {
        const rows = await store.user(s.userId, (tx) =>
          tx
            .deleteFrom('sessions')
            .where('id', '=', id)
            .where('user_id', '=', sql<string>`app.current_user_id()`)
            .returning('id')
            .execute(),
        );
        return rows.length === 0 ? fail(new AuthError('AUTH_NOT_FOUND')) : ok(undefined);
      } catch (error) {
        return fail(error);
      }
    },
  } satisfies Sessions);
}
