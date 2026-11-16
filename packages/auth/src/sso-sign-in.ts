import type { Result } from '@drefyn/address';
import {
  DbError,
  newId,
  withAuth,
  withOrganization,
  withUser,
  type AuthDatabase,
  type Database,
  type OrganizationSchema,
} from '@drefyn/db';
import { checkLimit } from '@drefyn/entitlements';
import { idOf, type OrganizationId, type UserId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { storedRole, storedTier } from './access.ts';
import { rateKeyForIp } from './client-ip.ts';
import type { AuthConfig } from './config.ts';
import type { BrowserContext, CookieSpec } from './cookies.ts';
import { newDeviceNotice, recordDevice, sendBoth } from './devices.ts';
import type { AuthNoticeMailer } from './email-change.ts';
import {
  createCodeIssuer,
  type PendingSsoLink,
  type SignedIn,
  type SsoLinkFinisher,
} from './email-sign-in.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import { countUsed, type OrganizationStore } from './organizations.ts';
import { canAssign, permissionsFor } from './permissions.ts';
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
  type SsoScope,
} from './session-support.ts';
import { hasConfirmedFactor } from './factor-rows.ts';
import { createSessions, factorRequired, type FactorRequired, type Sessions } from './sessions.ts';
import type { AuthMailer } from './step-up.ts';
import {
  isVerifiedIdentity,
  type SsoConnectionStatus,
  type VerifiedIdentity,
} from './verified-identity.ts';

export type SsoRefusal =
  // Just in time would go past org.seats.
  | 'AUTH_SSO_SEAT_LIMIT'
  // No membership, no invitation and just in time off, or a test connection and not its creator.
  | 'AUTH_SSO_NOT_PROVISIONED'
  // DREFYN_AUTH_SIGNUP=closed and no user.
  | 'AUTH_SSO_SIGNUP_CLOSED';

export type SsoCompleted =
  | {
      readonly kind: 'signed_in';
      readonly session: SessionInfo;
      readonly setCookies: readonly CookieSpec[];
      readonly returnTo: string;
      // The new device notice when one is owed. Never throws; run it after the response.
      readonly send?: () => Promise<void>;
    }
  // Signed in only once the second factor passes. No session exists yet.
  | FactorRequired
  // The address belongs to an account this identity is not linked to. send mails the code.
  | {
      readonly kind: 'link_code_sent';
      readonly setCookies: readonly CookieSpec[];
      readonly send: () => Promise<void>;
    }
  | { readonly kind: 'refused'; readonly reason: SsoRefusal };

// Whether a person has a second factor, read before a link is written. The session itself
// is gated by startSession, which reads the rows again under the factor lock.
export interface FactorRule {
  required(userId: UserId): Promise<boolean>;
}

export type SsoStore = SessionStore & OrganizationStore;

export interface SsoSignInDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: SsoStore;
  readonly logger: AuthLogger;
  readonly mailer: AuthMailer & AuthNoticeMailer;
  readonly sessions?: Pick<Sessions, 'startSession'>;
  readonly limiter?: RateLimiter;
  readonly factor?: FactorRule;
  readonly random?: (bytes: number) => Uint8Array;
}

export interface SsoSignIn extends SsoLinkFinisher {
  // Internal to the package: only the OIDC and SAML callbacks call it, with an identity
  // only they can mint.
  signInWithVerifiedIdentity(
    b: BrowserContext,
    identity: VerifiedIdentity,
    returnTo: string,
  ): Promise<Result<SsoCompleted, AuthError>>;
}

interface Connection {
  readonly status: SsoConnectionStatus;
  readonly jitEnabled: boolean;
  readonly jitProjectRole: 'editor' | 'viewer' | null;
  readonly displayName: string;
}

type Provisioned = 'member' | 'invited' | 'jit';

class Refused extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

const REFUSALS: ReadonlySet<AuthErrorCode> = new Set<SsoRefusal>([
  'AUTH_SSO_SEAT_LIMIT',
  'AUTH_SSO_NOT_PROVISIONED',
  'AUTH_SSO_SIGNUP_CLOSED',
]);
const isRefusal = (code: AuthErrorCode): code is SsoRefusal => REFUSALS.has(code);

const STATUSES: ReadonlySet<unknown> = new Set(['draft', 'test', 'active', 'disabled']);
const usable = (status: SsoConnectionStatus) => status === 'active' || status === 'test';
const jitOn = (c: Connection) => c.status === 'active' && c.jitEnabled;

// One parallel sign in can take the subject between the lookup and the insert. The second
// pass then finds it, so one retry is always enough.
const CREATE_PASSES = 2;

// Reads only the factor rows the person owns. A pending enrolment does not count.
export function enrolledFactorRule(store: SessionStore): FactorRule {
  return { required: (userId) => store.user(userId, hasConfirmedFactor) };
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

export function createSsoSignIn(config: AuthConfig, deps: SsoSignInDeps): SsoSignIn {
  const { db, authDb } = deps;
  const store: SsoStore =
    deps.store ??
    (db !== undefined && authDb !== undefined
      ? {
          user: (userId, work) => withUser(db, { userId }, work),
          auth: (work) => withAuth(authDb, work),
          organization: <T>(
            organizationId: OrganizationId,
            work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
          ) => withOrganization(db, { organizationId }, work),
          organizationAs: <T>(
            organizationId: OrganizationId,
            actorUserId: UserId,
            work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
          ) => withOrganization(db, { organizationId, actorUserId }, work),
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
  const sessions =
    deps.sessions ??
    (db !== undefined && authDb !== undefined
      ? createSessions(config, { db, authDb, logger: deps.logger, mailer: deps.mailer })
      : missing());
  const factor = deps.factor ?? enrolledFactorRule(store);
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

  // Ids and outcome codes only: never the address, the subject, the domain or a code.
  const ids = (scope: SsoScope, userId?: UserId) =>
    idFields({
      organizationId: ['org', scope.organizationId],
      connectionId: ['ssc', scope.connectionId],
      userId: ['usr', userId],
    });

  function refused(scope: SsoScope, reason: SsoRefusal): SsoCompleted {
    quietInfo(deps.logger, 'auth.sso_refused', { ...ids(scope), outcome: reason });
    return { kind: 'refused', reason };
  }

  function failed<T>(scope: SsoScope, error: unknown): Result<T, AuthError> {
    const failure = error instanceof Refused ? new AuthError(error.code) : error;
    const outcome = failure instanceof AuthError ? failure.code : 'AUTH_UNAVAILABLE';
    if (outcome === 'AUTH_UNAVAILABLE') quietWarn(deps.logger, 'auth.sso_failed', ids(scope));
    else quietInfo(deps.logger, 'auth.sso_refused', { ...ids(scope), outcome });
    return fail(failure);
  }

  // The connection as the sign in role may read it, held to the address's domain. A draft
  // or disabled connection, or a domain the connection's organization has not verified, ends
  // the sign in before anyone is looked up.
  async function connectionFor(scope: SsoScope, address: string): Promise<Connection> {
    const found = await store.auth(async (tx) => {
      const row = await tx
        .selectFrom('sso_connections')
        .select(['status', 'jit_enabled', 'jit_default_project_role', 'display_name'])
        .where('organization_id', '=', scope.organizationId)
        .where('id', '=', scope.connectionId)
        .executeTakeFirst();
      if (row === undefined) return null;
      const domain = await tx
        .selectFrom('sso_domains')
        .select('domain')
        .where('organization_id', '=', scope.organizationId)
        .where('connection_id', '=', scope.connectionId)
        .where('domain', '=', domainOf(address))
        .where('verified_at', 'is not', null)
        .executeTakeFirst();
      return { row, verified: domain !== undefined };
    });
    if (found === null || !STATUSES.has(found.row.status)) throw new Refused('AUTH_SSO_DISABLED');
    const role = found.row.jit_default_project_role;
    const connection: Connection = {
      status: found.row.status as SsoConnectionStatus,
      jitEnabled: found.row.jit_enabled,
      jitProjectRole: role === 'editor' || role === 'viewer' ? role : null,
      displayName: found.row.display_name,
    };
    if (!usable(connection.status)) throw new Refused('AUTH_SSO_DISABLED');
    if (!found.verified) throw new Refused('AUTH_SSO_EMAIL_OUTSIDE_DOMAIN');
    return connection;
  }

  // The person a link belongs to, marking the link used.
  async function linkedUser(scope: SsoScope, subject: string): Promise<UserId | null> {
    const row = await store.auth((tx) =>
      tx
        .updateTable('sso_identities')
        .set({ last_used_at: sql<Date>`now()` })
        .where('organization_id', '=', scope.organizationId)
        .where('connection_id', '=', scope.connectionId)
        .where('subject', '=', subject)
        .returning('user_id')
        .executeTakeFirst(),
    );
    return row === undefined ? null : idOf('usr', row.user_id);
  }

  async function userByAddress(address: string): Promise<UserId | null> {
    const row = await store.auth((tx) =>
      tx
        .selectFrom('users')
        .select('id')
        .where('email_normalized', '=', address)
        .executeTakeFirst(),
    );
    return row === undefined ? null : idOf('usr', row.id);
  }

  // A connection in test signs in the member who made it and nobody else.
  async function isCreator(scope: SsoScope, userId: UserId): Promise<boolean> {
    const row = await store.organization(scope.organizationId, (tx) =>
      tx
        .selectFrom('sso_connections as c')
        .innerJoin('memberships as m', (join) =>
          join
            .onRef('m.organization_id', '=', 'c.organization_id')
            .onRef('m.id', '=', 'c.created_by'),
        )
        .select('m.id')
        .where('c.organization_id', '=', scope.organizationId)
        .where('c.id', '=', scope.connectionId)
        .where('m.user_id', '=', userId)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  async function invited(scope: SsoScope, address: string): Promise<boolean> {
    const row = await store.organization(scope.organizationId, (tx) =>
      tx
        .selectFrom('invitations')
        .select('id')
        .where('organization_id', '=', scope.organizationId)
        .where('email_normalized', '=', address)
        .where('expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst(),
    );
    return row !== undefined;
  }

  // Sign up mode as for every other method, except that in invite_only a just in time
  // connection invites its verified domains, and a live invitation to this organization
  // counts as it would by link.
  async function mayCreate(scope: SsoScope, c: Connection, address: string): Promise<boolean> {
    if (config.signUp === 'open') return true;
    if (jitOn(c)) return true;
    return invited(scope, address);
  }

  // The user and the link together, or neither. 'taken' when the address was signed up a
  // moment ago, and 'raced' when a parallel sign in linked the subject first.
  async function createUser(identity: VerifiedIdentity): Promise<UserId | 'taken' | 'raced'> {
    const id = newId('usr');
    try {
      return await store.auth(async (tx) => {
        const made = await tx
          .insertInto('users')
          .values({
            id,
            email: identity.email,
            email_normalized: identity.email,
            display_name: identity.displayName,
            email_verified_at: sql<Date>`now()`,
          })
          .onConflict((c) => c.column('email_normalized').doNothing())
          .returning('id')
          .executeTakeFirst();
        if (made === undefined) return 'taken' as const;
        await tx
          .insertInto('sso_identities')
          .values({
            organization_id: identity.organizationId,
            connection_id: identity.connectionId,
            user_id: id,
            subject: identity.subject,
            email_normalized: identity.email,
            last_used_at: sql<Date>`now()`,
          })
          .execute();
        return id;
      });
    } catch (error) {
      if (error instanceof DbError && error.code === 'DB_UNIQUE_VIOLATION') return 'raced';
      throw error;
    }
  }

  // Membership, in one transaction acting as the person. An existing membership is used; a
  // live invitation for the address is accepted; else just in time adds a member under the
  // organization's row lock, so two sign ins never count the same free seat. Idempotent on
  // (organization_id, user_id), so a sign in that failed here completes on the next try.
  async function provision(
    scope: SsoScope,
    c: Connection,
    userId: UserId,
    address: string,
  ): Promise<Provisioned> {
    return store.organizationAs(scope.organizationId, userId, async (tx) => {
      const memberOf = () =>
        tx
          .selectFrom('memberships')
          .select('id')
          .where('organization_id', '=', scope.organizationId)
          .where('user_id', '=', userId)
          .executeTakeFirst();
      if ((await memberOf()) !== undefined) return 'member';
      if (c.status === 'test') throw new Refused('AUTH_SSO_NOT_PROVISIONED');
      const invitation = await tx
        .selectFrom('invitations as i')
        .leftJoin('memberships as inviter', (join) =>
          join
            .onRef('inviter.organization_id', '=', 'i.organization_id')
            .onRef('inviter.id', '=', 'i.invited_by'),
        )
        .select(['i.id', 'i.role', 'i.default_project_role', 'inviter.role as inviter_role'])
        .where('i.organization_id', '=', scope.organizationId)
        .where('i.email_normalized', '=', address)
        .where('i.expires_at', '>', sql<Date>`now()`)
        .executeTakeFirst();
      if (invitation !== undefined) {
        const role = storedRole(invitation.role);
        const inviterRole =
          invitation.inviter_role === null ? null : storedRole(invitation.inviter_role);
        // As by link: the inviter must still be able to grant the role.
        const valid =
          inviterRole !== null &&
          permissionsFor(inviterRole, new Set()).includes('org.manage_members') &&
          canAssign(inviterRole, role);
        if (valid) {
          const projectRole = invitation.default_project_role;
          const made = await tx
            .insertInto('memberships')
            .values({
              organization_id: scope.organizationId,
              user_id: userId,
              role,
              default_project_role:
                projectRole === 'editor' || projectRole === 'viewer' ? projectRole : null,
              invitation_id: invitation.id,
            })
            .onConflict((oc) => oc.columns(['organization_id', 'user_id']).doNothing())
            .returning('id')
            .executeTakeFirst();
          await tx
            .deleteFrom('invitations')
            .where('organization_id', '=', scope.organizationId)
            .where('id', '=', invitation.id)
            .execute();
          return made === undefined ? 'member' : 'invited';
        }
      }
      if (!jitOn(c)) throw new Refused('AUTH_SSO_NOT_PROVISIONED');
      // Every seat change in this organization waits here, as invite does.
      await tx
        .selectFrom('organizations')
        .select('organization_id')
        .where('organization_id', '=', scope.organizationId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if ((await memberOf()) !== undefined) return 'member';
      const { used, tier } = await countUsed(tx, scope.organizationId, null);
      // The tier as stored now, so a downgrade already counts.
      if (checkLimit(storedTier(tier), 'org.seats', used + 1).status !== 'allowed') {
        throw new Refused('AUTH_SSO_SEAT_LIMIT');
      }
      await tx
        .insertInto('memberships')
        .values({
          organization_id: scope.organizationId,
          user_id: userId,
          role: 'member',
          default_project_role: c.jitProjectRole,
        })
        .execute();
      return 'jit';
    });
  }

  // Membership, then the factor rule, then the session, as every method ends.
  async function finish(
    b: BrowserContext,
    scope: SsoScope,
    c: Connection,
    userId: UserId,
    address: string,
    returnTo: string,
    created: boolean,
  ): Promise<SsoCompleted> {
    let provisioned: Provisioned;
    try {
      provisioned = await provision(scope, c, userId, address);
    } catch (error) {
      if (error instanceof Refused && isRefusal(error.code)) return refused(scope, error.code);
      throw error;
    }
    if (provisioned !== 'member') {
      quietInfo(deps.logger, 'auth.sso_provisioned', {
        ...ids(scope, userId),
        via: provisioned === 'jit' ? 'jit' : 'invitation',
      });
    }
    const started = await sessions.startSession(b, {
      userId,
      method: 'sso',
      sso: scope,
      returnTo,
    });
    // The challenge keeps the scope, so the session it ends in is still an SSO one. The
    // device and its notice wait for the factor.
    if (factorRequired(started)) {
      quietInfo(deps.logger, 'auth.sso_factor_required', ids(scope, userId));
      return started;
    }
    const device = await recordDevice(config, devices, b, userId);
    const seen = device.newDevice;
    // An account made by this very sign in has no device to tell apart from this one.
    const owed = seen !== null && !created;
    quietInfo(deps.logger, 'auth.sso_signed_in', {
      ...ids(scope, userId),
      ...idFields({ sessionId: ['ses', started.session.sessionId] }),
    });
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
              method: 'sso',
              seen,
            }),
          }
        : {}),
    };
  }

  async function sendLinkCode(
    b: BrowserContext,
    identity: VerifiedIdentity,
    c: Connection,
    userId: UserId,
    returnTo: string,
  ): Promise<SsoCompleted> {
    const scope = { organizationId: identity.organizationId, connectionId: identity.connectionId };
    const ipKey = rateKeyForIp(b.ip);
    await limiter.reserve('email_send', [identity.email, ipKey]);
    await limiter.reserve('email_send_ip', [ipKey]);
    const issued = await issuer.issue(b, {
      purpose: 'link_identity',
      email: identity.email,
      userId,
      linking: { provider: 'sso', account: c.displayName, subject: identity.subject, sso: scope },
      returnTo,
    });
    if (!issued.ok) throw issued.error;
    quietInfo(deps.logger, 'auth.sso_link_sent', ids(scope, userId));
    return { kind: 'link_code_sent', setCookies: issued.value.setCookies, send: issued.value.send };
  }

  async function signIn(
    b: BrowserContext,
    identity: VerifiedIdentity,
    returnTo: string,
  ): Promise<SsoCompleted> {
    const scope = { organizationId: identity.organizationId, connectionId: identity.connectionId };
    const address = identity.email;
    const c = await connectionFor(scope, address);
    const mayUse = async (userId: UserId) =>
      c.status === 'active' || (await isCreator(scope, userId));
    for (let pass = 1; ; pass += 1) {
      const owner = await linkedUser(scope, identity.subject);
      if (owner !== null) {
        if (!(await mayUse(owner))) return refused(scope, 'AUTH_SSO_NOT_PROVISIONED');
        return finish(b, scope, c, owner, address, returnTo, false);
      }
      // Never linked by a matching address alone: a changed email claim at the IdP must not
      // reach someone else's account, so the address proves itself by code first.
      const existing = await userByAddress(address);
      if (existing !== null) {
        if (!(await mayUse(existing))) return refused(scope, 'AUTH_SSO_NOT_PROVISIONED');
        return sendLinkCode(b, identity, c, existing, returnTo);
      }
      // Only the creator signs in through a test connection, and the creator has an account.
      if (c.status === 'test') return refused(scope, 'AUTH_SSO_NOT_PROVISIONED');
      if (config.signUp === 'closed') return refused(scope, 'AUTH_SSO_SIGNUP_CLOSED');
      if (!(await mayCreate(scope, c, address))) return refused(scope, 'AUTH_SSO_NOT_PROVISIONED');
      const made = await createUser(identity);
      if (made === 'taken') {
        const raced = await userByAddress(address);
        if (raced !== null) return sendLinkCode(b, identity, c, raced, returnTo);
      } else if (made !== 'raced') {
        quietInfo(deps.logger, 'auth.sso_user_created', ids(scope, made));
        return finish(b, scope, c, made, address, returnTo, true);
      }
      if (pass >= CREATE_PASSES) throw new AuthError('AUTH_UNAVAILABLE');
    }
  }

  return Object.freeze({
    async signInWithVerifiedIdentity(b, identity, returnTo) {
      // Typed as minted, but checked again at run time: a cast must not get through.
      if (!isVerifiedIdentity(identity)) return fail(new AuthError('AUTH_INPUT_INVALID'));
      const scope = {
        organizationId: identity.organizationId,
        connectionId: identity.connectionId,
      };
      try {
        return ok(await signIn(b, identity, safeReturnTo(returnTo, config.appOrigin)));
      } catch (error) {
        return failed(scope, error);
      }
    },

    async finishLink(
      b,
      link: PendingSsoLink,
    ): Promise<Result<SignedIn | FactorRequired, AuthError>> {
      const scope = link.sso;
      try {
        const c = await connectionFor(scope, link.email);
        if (c.status === 'test' && !(await isCreator(scope, link.userId))) {
          throw new Refused('AUTH_SSO_NOT_PROVISIONED');
        }
        // An enrolled person adds no credential before the factor. The link is dropped and
        // the proved code hands off to a factor challenge as an email sign in, so the
        // session carries no SSO scope the identity never earned.
        if (await factor.required(link.userId)) {
          quietInfo(deps.logger, 'auth.sso_link_dropped_for_factor', ids(scope, link.userId));
          const started = await sessions.startSession(b, {
            userId: link.userId,
            method: 'email',
            returnTo: link.returnTo,
          });
          // Removed meanwhile: the code proved the address, which is an email sign in.
          if (factorRequired(started)) return ok(started);
          return ok({
            session: started.session,
            setCookies: started.setCookies,
            returnTo: link.returnTo,
          });
        }
        const made = await store.auth((tx) =>
          tx
            .insertInto('sso_identities')
            .values({
              organization_id: scope.organizationId,
              connection_id: scope.connectionId,
              user_id: link.userId,
              subject: link.subject,
              email_normalized: link.email,
              last_used_at: sql<Date>`now()`,
            })
            .onConflict((oc) => oc.doNothing())
            .returning('created_at')
            .executeTakeFirst(),
        );
        // The subject was linked to someone meanwhile, or this person already has a link on
        // the connection. The same answer as a wrong code.
        if (made === undefined) throw new Refused('AUTH_CODE_INVALID');
        quietInfo(deps.logger, 'auth.sso_linked', ids(scope, link.userId));
        const done = await finish(b, scope, c, link.userId, link.email, link.returnTo, false);
        if (done.kind === 'refused') return fail(new AuthError(done.reason));
        // Enrolled after the read above: the link stands, and the sign in waits on the factor.
        if (done.kind === 'factor_required') return ok(done);
        if (done.kind !== 'signed_in') throw new Refused('AUTH_UNAVAILABLE');
        const notice = linkNotice(link.email, c.displayName, made.created_at, scope, link.userId);
        const send = sendBoth(notice, done.send);
        return ok({
          session: done.session,
          setCookies: done.setCookies,
          returnTo: done.returnTo,
          ...(send === undefined ? {} : { send }),
        });
      } catch (error) {
        return failed(scope, error);
      }
    },
  } satisfies SsoSignIn);

  function linkNotice(to: string, account: string, at: Date, scope: SsoScope, userId: UserId) {
    return async () => {
      try {
        await deps.mailer.sendSecurityNotice(to, {
          kind: 'identity_linked',
          provider: 'sso',
          account,
          at,
        });
      } catch {
        quietWarn(deps.logger, 'auth.identity_notice_failed', ids(scope, userId));
      }
    };
  }
}

function missing(): never {
  throw new TypeError('createSsoSignIn needs db and authDb, or a store, limiter and sessions');
}
