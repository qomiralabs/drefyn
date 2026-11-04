import { randomBytes } from 'node:crypto';
import type { Result } from '@drefyn/address';
import {
  newId,
  withOrganization,
  withUser,
  type AuthDatabase,
  type Database,
  type OrganizationSchema,
} from '@drefyn/db';
import { checkLimit, limitFor, type LimitValue } from '@drefyn/entitlements';
import { idOf, type IdOf, type OrganizationId, type UserId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { grantAccess, storedRole, storedTier, type AccessContext } from './access.ts';
import { normalizeAddress } from './address.ts';
import type { AuthConfig } from './config.ts';
import { INVITE_MAX_AGE_SECONDS, type BrowserContext, type CookieSpec } from './cookies.ts';
import type { AuthNoticeMailer } from './email-change.ts';
import type { PendingInvitations } from './email-sign-in.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import {
  invitationBlockLink,
  invitationLink,
  formatBlockToken,
  parseBlockToken,
} from './invitation-links.ts';
import { constantTimeEqual, sha256 } from './keys.ts';
import { UNNAMED_PERSON, checkedDisplayName, memberName, noticeEach } from './notices.ts';
import type { OrganizationStore } from './organizations.ts';
import { ORG_ROLES, canAssign, permissionsFor, type OrgRole } from './permissions.ts';
import { createRateLimiter, type AuthLogger, type RateLimiter } from './rate-limiter.ts';
import {
  fail,
  idFields,
  ok,
  quietInfo,
  quietWarn,
  unavailable,
  type SessionInfo,
} from './session-support.ts';
import { checkRecentAuth } from './step-up.ts';
import {
  SECRET_BYTES,
  formatInvitationToken,
  parseInvitationToken,
  type InvitationToken,
} from './tokens.ts';

export type DefaultProjectRole = 'editor' | 'viewer';

// What the invitation mail needs. The adapter maps it onto the email package; blockLink is
// required on both sides, so no build can send an invitation without it.
export interface InvitationSend {
  readonly organizationId: OrganizationId;
  readonly invitationId: IdOf<'inv'>;
  // For the idempotency key invite:<organization>:<invitation>:<sendCount>.
  readonly sendCount: number;
  readonly organizationName: string;
  readonly inviterName: string;
  readonly link: URL;
  readonly blockLink: URL;
  readonly expiresAt: Date;
}

export interface AuthInvitationMailer {
  sendInvitation(to: string, invitation: InvitationSend): Promise<void>;
}

export interface InvitationSummary {
  readonly invitationId: IdOf<'inv'>;
  readonly organizationId: OrganizationId;
  readonly email: string;
  readonly role: OrgRole;
  readonly defaultProjectRole: DefaultProjectRole | null;
  readonly expiresAt: Date;
}

export type InviteOutcome =
  // send never throws and is meant to run after the response.
  | {
      readonly kind: 'sent';
      readonly invitation: InvitationSummary;
      readonly send: () => Promise<void>;
    }
  // The person asked not to get invitations from this organization. No row is made, so no
  // seat is taken, and the admin is told so rather than shown a success.
  | { readonly kind: 'blocked' };

export interface InvitationBlockView {
  readonly organizationId: OrganizationId;
  readonly organizationName: string;
}

// What the invitation page shows the person holding the token.
export interface InvitationView {
  readonly organizationId: OrganizationId;
  readonly organizationName: string;
  readonly inviterName: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly defaultProjectRole: DefaultProjectRole | null;
  readonly expiresAt: Date;
  // Refusing must not need the mail, so the page offers the same link the mail carries.
  readonly blockLink: URL;
}

export interface AcceptedInvitation {
  readonly access: AccessContext;
  // Clears the held invitation, which has done its job.
  readonly setCookies: readonly CookieSpec[];
}

export interface Invitations extends PendingInvitations {
  invite(
    a: AccessContext,
    input: {
      readonly email: string;
      readonly role: OrgRole;
      readonly defaultProjectRole: DefaultProjectRole | null;
    },
  ): Promise<Result<InviteOutcome, AuthError>>;
  acceptInvitation(s: SessionInfo, token: string): Promise<Result<AcceptedInvitation, AuthError>>;
  // What the invite page does for a signed out person: keeps the token in a short lived
  // cookie while they sign up. Parses only; nothing is read until sign up asks.
  holdInvitation(
    b: BrowserContext,
    token: string,
  ): Result<{ readonly setCookies: readonly CookieSpec[] }, AuthError>;
  // What the invitation page shows. Reads only, and only for the token's own organization.
  readInvitation(token: string): Promise<Result<InvitationView, AuthError>>;
  // What the block page shows. Reads only: mail scanners open every link.
  readInvitationBlock(token: string): Promise<Result<InvitationBlockView, AuthError>>;
  // The page's POST. A second call with the same token changes nothing and still succeeds.
  blockInvitation(token: string): Promise<Result<void, AuthError>>;
  seatUsage(a: AccessContext): Promise<{ readonly used: number; readonly limit: LimitValue }>;
}

export interface InvitationsDeps {
  readonly db: Database;
  readonly authDb: AuthDatabase;
  readonly logger: AuthLogger;
  readonly mailer: AuthInvitationMailer & AuthNoticeMailer;
  readonly limiter?: RateLimiter;
  readonly store?: OrganizationStore;
  readonly random?: (bytes: number) => Uint8Array;
  readonly now?: () => Date;
}

const BLOCK_LINK_SECONDS = 30 * 86_400;
const DEFAULT_ROLES: ReadonlySet<unknown> = new Set(['editor', 'viewer']);
const ROLES: ReadonlySet<unknown> = new Set(ORG_ROLES);

// Said in the mail when the inviter's own name cannot be: never their address, which a
// stranger has no business receiving and a mail client would turn into a link.
export const INVITER_FALLBACK = UNNAMED_PERSON;

export const plainInviterName = (displayName: string | null): string =>
  checkedDisplayName(displayName) ?? INVITER_FALLBACK;

class Refused extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

const BLOCKED = Symbol('blocked');

interface ProvedInvitation {
  readonly id: IdOf<'inv'>;
  readonly emailNormalized: string;
  readonly role: OrgRole;
  readonly defaultProjectRole: unknown;
  readonly invitedBy: string;
  readonly expiresAt: Date;
}

// The one check of an invitation token. It sends a single statement, by id within the
// token's own organization, and compares in process; nothing else runs until it passes.
// Sign up in invite_only reuses it.
export async function proveInvitation(
  tx: Transaction<OrganizationSchema>,
  token: InvitationToken,
): Promise<ProvedInvitation | null> {
  const row = await tx
    .selectFrom('invitations')
    .select([
      'id',
      'email_normalized',
      'role',
      'default_project_role',
      'invited_by',
      'secret_hash',
      'expires_at',
      sql<boolean>`expires_at > now()`.as('live'),
    ])
    .where('organization_id', '=', token.organizationId)
    .where('id', '=', token.invitationId)
    .executeTakeFirst();
  const expected = sha256(token.secret);
  // Compared even with no row, so a missing invitation costs the same as a wrong secret.
  const matches = constantTimeEqual(expected, row?.secret_hash ?? Buffer.alloc(expected.length));
  if (row === undefined || !matches || !row.live) return null;
  return {
    id: idOf('inv', row.id),
    emailNormalized: row.email_normalized,
    role: storedRole(row.role),
    defaultProjectRole: row.default_project_role,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
  };
}

// Pending invitations that have not expired, plus every membership. The invited address
// can be left out, so a resend never asks for a second seat.
async function countUsed(
  tx: Transaction<OrganizationSchema>,
  organizationId: OrganizationId,
  except: string | null,
): Promise<{ used: number; tier: string }> {
  const leaveOut = except === null ? sql`` : sql`and email_normalized <> ${except}`;
  const { rows } = await sql<{ used: number; plan_tier: string }>`
    select o.plan_tier,
      ((select count(*) from memberships where organization_id = ${organizationId})
       + (select count(*) from invitations
           where organization_id = ${organizationId} and expires_at > now() ${leaveOut}))::int
        as used
    from organizations o where o.organization_id = ${organizationId}`.execute(tx);
  const row = rows[0];
  if (row === undefined) throw new Error('organization row is missing');
  return { used: row.used, tier: row.plan_tier };
}

// Read inside the transaction that made the owner, so the row is there to name them, and the
// notice goes only to the owners who were there before.
async function ownersBeside(tx: Transaction<OrganizationSchema>, newOwner: UserId) {
  const rows = await tx
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.id', 'u.email', 'u.display_name', sql<Date>`now()`.as('at')])
    .where('m.role', '=', 'owner')
    .execute();
  const self = rows.find((r) => r.id === newOwner);
  if (self === undefined) throw new Error('the new owner row is missing');
  return {
    name: memberName(self.display_name, self.email),
    others: rows.filter((r) => r.id !== newOwner).map((r) => r.email),
    at: self.at,
  };
}

export function createInvitations(config: AuthConfig, deps: InvitationsDeps): Invitations {
  const store: OrganizationStore = deps.store ?? {
    user: (userId, work) => withUser(deps.db, { userId }, work),
    organization: <T>(
      organizationId: OrganizationId,
      work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
    ) => withOrganization(deps.db, { organizationId }, work),
    organizationAs: <T>(
      organizationId: OrganizationId,
      actorUserId: UserId,
      work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
    ) => withOrganization(deps.db, { organizationId, actorUserId }, work),
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
  const now = deps.now ?? (() => new Date());
  const blocks = config.invitationBlocks;

  // Refusals the admin sees are logged by code, with ids only.
  function refuse<T>(code: AuthErrorCode, ids: Record<string, readonly ['org' | 'usr', unknown]>) {
    quietInfo(deps.logger, 'auth.invitation_refused', { ...idFields(ids), outcome: code });
    return fail<T>(new AuthError(code));
  }

  function blockTokenFor(
    organizationId: OrganizationId,
    invitationId: IdOf<'inv'>,
    address: string,
  ) {
    const emailHmac = blocks.emailMac(organizationId, address);
    const expiresAt = Math.floor(now().getTime() / 1000) + BLOCK_LINK_SECONDS;
    const parts = { organizationId, invitationId, emailHmac, expiresAt };
    return formatBlockToken({ ...parts, tag: blocks.linkTag(parts) });
  }

  // A block token auth made and that has not run out, or null. No statement is sent first.
  function provedBlock(token: string) {
    const parsed = parseBlockToken(token);
    if (parsed === null) return null;
    if (!blocks.verifyLinkTag(parsed, parsed.tag)) return null;
    if (parsed.expiresAt * 1000 <= now().getTime()) return null;
    return parsed;
  }

  return Object.freeze({
    async invite(a, input) {
      const ids = { organizationId: ['org', a.organizationId], userId: ['usr', a.userId] } as const;
      if (!a.permissions.includes('org.manage_members')) return refuse('AUTH_FORBIDDEN', ids);
      const raw = input as { email?: unknown; role?: unknown; defaultProjectRole?: unknown };
      const address = normalizeAddress(raw.email);
      const role = raw.role;
      const defaultRole = raw.defaultProjectRole ?? null;
      if (
        address === null ||
        !ROLES.has(role) ||
        (defaultRole !== null && !DEFAULT_ROLES.has(defaultRole))
      ) {
        return fail(new AuthError('AUTH_INPUT_INVALID'));
      }
      const target = role as OrgRole;
      const defaultProjectRole = defaultRole as DefaultProjectRole | null;
      if (!canAssign(a.role, target)) return refuse('AUTH_FORBIDDEN', ids);
      // An owner invitation is a way to add an owner, so it answers to the rule for role
      // changes. First, because the limiter below writes.
      if (target === 'owner') {
        const recent = await checkRecentAuth(store, a);
        if (!recent.ok) {
          quietInfo(deps.logger, 'auth.invitation_refused', {
            ...idFields(ids),
            outcome: recent.error.code,
          });
          return recent;
        }
      }
      // Counted before the work and outside it, so refused and failed attempts count too.
      try {
        await limiter.reserve('invite_send', [a.organizationId]);
        await limiter.reserve('invite_send_user', [a.userId]);
        await limiter.reserve('invite_recipient', [address]);
      } catch (error) {
        return fail(error);
      }
      const secret = random(SECRET_BYTES);
      let made: {
        id: IdOf<'inv'>;
        sendCount: number;
        expiresAt: Date;
        organizationName: string;
        inviterName: string;
      };
      try {
        const outcome = await store.organizationAs(a.organizationId, a.userId, async (tx) => {
          // Every invite in this organization waits here, so the count below cannot race.
          const org = await tx
            .selectFrom('organizations')
            .select(['plan_tier', 'name'])
            .where('organization_id', '=', a.organizationId)
            .forUpdate()
            .executeTakeFirstOrThrow();
          // The role as stored now, not as the guard saw it at the start of the request.
          const actor = await tx
            .selectFrom('memberships as m')
            .innerJoin('users as u', 'u.id', 'm.user_id')
            .select(['m.id', 'm.role', 'u.display_name'])
            .where('m.organization_id', '=', a.organizationId)
            .where('m.user_id', '=', a.userId)
            .executeTakeFirst();
          const actorRole = actor === undefined ? null : storedRole(actor.role);
          if (
            actor === undefined ||
            actorRole === null ||
            !permissionsFor(actorRole, new Set()).includes('org.manage_members') ||
            !canAssign(actorRole, target)
          ) {
            throw new Refused('AUTH_FORBIDDEN');
          }
          const member = await tx
            .selectFrom('memberships as m')
            .innerJoin('users as u', 'u.id', 'm.user_id')
            .select('m.id')
            .where('m.organization_id', '=', a.organizationId)
            .where('u.email', '=', address)
            .executeTakeFirst();
          if (member !== undefined) throw new Refused('AUTH_ALREADY_MEMBER');
          const blocked = await tx
            .selectFrom('invitation_blocks')
            .select('id')
            .where('organization_id', '=', a.organizationId)
            .where('email_hmac', '=', blocks.emailMac(a.organizationId, address))
            .executeTakeFirst();
          if (blocked !== undefined) return BLOCKED;
          const { used, tier } = await countUsed(tx, a.organizationId, address);
          // The tier as stored now, so a downgrade since sign in already counts.
          if (checkLimit(storedTier(tier), 'org.seats', used + 1).status !== 'allowed') {
            throw new Refused('AUTH_SEAT_LIMIT');
          }
          const row = await tx
            .insertInto('invitations')
            .values({
              id: newId('inv'),
              organization_id: a.organizationId,
              email_normalized: address,
              role: target,
              default_project_role: defaultProjectRole,
              secret_hash: sha256(secret),
              invited_by: actor.id,
              expires_at: sql<Date>`now() + interval '7 days'`,
            })
            // A resend replaces the secret, so an older link stops working.
            .onConflict((oc) =>
              oc.columns(['organization_id', 'email_normalized']).doUpdateSet((eb) => ({
                role: eb.ref('excluded.role'),
                default_project_role: eb.ref('excluded.default_project_role'),
                secret_hash: eb.ref('excluded.secret_hash'),
                invited_by: eb.ref('excluded.invited_by'),
                expires_at: eb.ref('excluded.expires_at'),
                send_count: sql<number>`invitations.send_count + 1`,
                updated_at: sql<Date>`now()`,
              })),
            )
            .returning(['id', 'send_count', 'expires_at'])
            .executeTakeFirstOrThrow();
          return {
            id: idOf('inv', row.id),
            sendCount: row.send_count,
            expiresAt: row.expires_at,
            organizationName: org.name,
            inviterName: plainInviterName(actor.display_name),
          };
        });
        if (outcome === BLOCKED) {
          quietInfo(deps.logger, 'auth.invitation_refused', {
            ...idFields(ids),
            outcome: 'blocked',
          });
          return ok({ kind: 'blocked' } as const);
        }
        made = outcome;
      } catch (error) {
        if (error instanceof Refused) return refuse(error.code, ids);
        quietWarn(deps.logger, 'auth.invitation_create_failed', idFields(ids));
        return fail(error);
      }
      const logIds = idFields({ ...ids, invitationId: ['inv', made.id] });
      quietInfo(deps.logger, 'auth.invitation_created', { ...logIds, sendCount: made.sendCount });
      const token = formatInvitationToken({
        organizationId: a.organizationId,
        invitationId: made.id,
        secret,
      });
      const mail: InvitationSend = {
        organizationId: a.organizationId,
        invitationId: made.id,
        sendCount: made.sendCount,
        organizationName: made.organizationName,
        inviterName: made.inviterName,
        link: invitationLink(config.appOrigin, token),
        blockLink: invitationBlockLink(
          config.appOrigin,
          blockTokenFor(a.organizationId, made.id, address),
        ),
        expiresAt: made.expiresAt,
      };
      const send = async () => {
        try {
          await deps.mailer.sendInvitation(address, mail);
        } catch {
          quietWarn(deps.logger, 'auth.invitation_send_failed', logIds);
        }
      };
      return ok({
        kind: 'sent',
        invitation: Object.freeze({
          invitationId: made.id,
          organizationId: a.organizationId,
          email: address,
          role: target,
          defaultProjectRole,
          expiresAt: made.expiresAt,
        }),
        send,
      } as const);
    },

    async acceptInvitation(s, token) {
      const parsed = parseInvitationToken(token);
      if (parsed === null) return fail(new AuthError('AUTH_INVITATION_INVALID'));
      const ids = {
        organizationId: ['org', parsed.organizationId],
        userId: ['usr', s.userId],
        invitationId: ['inv', parsed.invitationId],
      } as const;
      let accepted: {
        membershipId: string;
        role: OrgRole;
        defaultProjectRole: unknown;
        tier: string;
        newOwner: { readonly name: string; readonly others: string[]; readonly at: Date } | null;
      };
      try {
        accepted = await store.organizationAs(parsed.organizationId, s.userId, async (tx) => {
          const invitation = await proveInvitation(tx, parsed);
          if (invitation === null) throw new Refused('AUTH_INVITATION_INVALID');
          if (normalizeAddress(s.email) !== invitation.emailNormalized) {
            throw new Refused('AUTH_INVITATION_EMAIL_MISMATCH');
          }
          // The inviter must still be able to grant this role. Removing them already took
          // the invitation with it; a demotion is caught here.
          const inviter = await tx
            .selectFrom('memberships')
            .select('role')
            .where('organization_id', '=', parsed.organizationId)
            .where('id', '=', invitation.invitedBy)
            .executeTakeFirst();
          const inviterRole = inviter === undefined ? null : storedRole(inviter.role);
          if (
            inviterRole === null ||
            !permissionsFor(inviterRole, new Set()).includes('org.manage_members') ||
            !canAssign(inviterRole, invitation.role)
          ) {
            throw new Refused('AUTH_INVITATION_INVALID');
          }
          const org = await tx
            .selectFrom('organizations')
            .select('plan_tier')
            .where('organization_id', '=', parsed.organizationId)
            .executeTakeFirstOrThrow();
          // The database lets this row in only because the invitation names it, with the same
          // role, and is still live.
          const member = await tx
            .insertInto('memberships')
            .values({
              organization_id: parsed.organizationId,
              user_id: s.userId,
              role: invitation.role,
              default_project_role: invitation.defaultProjectRole as DefaultProjectRole | null,
              invitation_id: invitation.id,
            })
            .onConflict((oc) => oc.columns(['organization_id', 'user_id']).doNothing())
            .returning('id')
            .executeTakeFirst();
          if (member === undefined) throw new Refused('AUTH_ALREADY_MEMBER');
          await tx
            .deleteFrom('invitations')
            .where('organization_id', '=', parsed.organizationId)
            .where('id', '=', invitation.id)
            .execute();
          return {
            membershipId: member.id,
            role: invitation.role,
            defaultProjectRole: invitation.defaultProjectRole,
            tier: org.plan_tier,
            newOwner: invitation.role === 'owner' ? await ownersBeside(tx, s.userId) : null,
          };
        });
      } catch (error) {
        if (error instanceof Refused) {
          quietInfo(deps.logger, 'auth.invitation_refused', {
            ...idFields(ids),
            outcome: error.code,
          });
          return fail(new AuthError(error.code));
        }
        quietWarn(deps.logger, 'auth.invitation_accept_failed', idFields(ids));
        return fail(error);
      }
      quietInfo(
        deps.logger,
        'auth.invitation_accepted',
        idFields({ ...ids, membershipId: ['mem', accepted.membershipId] }),
      );
      if (accepted.newOwner !== null) {
        const { name, others, at } = accepted.newOwner;
        await noticeEach(
          deps.mailer,
          others,
          {
            kind: 'owner_added',
            organizationId: parsed.organizationId,
            membershipId: idOf('mem', accepted.membershipId),
            memberName: name,
            at,
          },
          () => {
            quietWarn(
              deps.logger,
              'auth.member_notice_failed',
              idFields({ ...ids, membershipId: ['mem', accepted.membershipId] }),
            );
          },
        );
      }
      return ok({
        access: grantAccess({
          organizationId: parsed.organizationId,
          userId: s.userId,
          sessionId: s.sessionId,
          role: accepted.role,
          defaultProjectRole: accepted.defaultProjectRole,
          tier: accepted.tier,
          authenticatedAt: s.authenticatedAt,
        }),
        setCookies: [{ name: config.cookies.invite, value: '', maxAgeSeconds: 0 }],
      });
    },

    holdInvitation(_b, token) {
      if (parseInvitationToken(token) === null) {
        return fail(new AuthError('AUTH_INVITATION_INVALID'));
      }
      // The parser accepts only the canonical form, so the token is stored as given.
      return ok({
        setCookies: [
          { name: config.cookies.invite, value: token, maxAgeSeconds: INVITE_MAX_AGE_SECONDS },
        ],
      });
    },

    async allowsSignUp(token, emailNormalized) {
      // No statement for a missing or broken cookie, so only the request decides the work.
      const parsed = parseInvitationToken(token);
      if (parsed === null) return false;
      try {
        const invitation = await store.organization(parsed.organizationId, (tx) =>
          proveInvitation(tx, parsed),
        );
        return invitation !== null && invitation.emailNormalized === emailNormalized;
      } catch {
        // Fails closed: the newcomer is answered like any address and nobody is let in.
        quietWarn(
          deps.logger,
          'auth.invitation_check_failed',
          idFields({ organizationId: ['org', parsed.organizationId] }),
        );
        return false;
      }
    },

    async readInvitation(token) {
      const parsed = parseInvitationToken(token);
      if (parsed === null) return fail(new AuthError('AUTH_INVITATION_INVALID'));
      const { organizationId } = parsed;
      try {
        const view = await store.organization(organizationId, async (tx) => {
          const invitation = await proveInvitation(tx, parsed);
          if (invitation === null) return null;
          const organization = await tx
            .selectFrom('organizations')
            .select('name')
            .where('organization_id', '=', organizationId)
            .executeTakeFirst();
          if (organization === undefined) return null;
          const inviter = await tx
            .selectFrom('memberships as m')
            .innerJoin('users as u', 'u.id', 'm.user_id')
            .select('u.display_name')
            .where('m.organization_id', '=', organizationId)
            .where('m.id', '=', invitation.invitedBy)
            .executeTakeFirst();
          return { invitation, organization, inviter };
        });
        if (view === null) return fail(new AuthError('AUTH_INVITATION_INVALID'));
        const { invitation } = view;
        const projectRole = invitation.defaultProjectRole;
        return ok({
          organizationId,
          organizationName: view.organization.name,
          inviterName: plainInviterName(view.inviter?.display_name ?? null),
          email: invitation.emailNormalized,
          role: invitation.role,
          defaultProjectRole:
            projectRole === 'editor' || projectRole === 'viewer' ? projectRole : null,
          expiresAt: invitation.expiresAt,
          blockLink: invitationBlockLink(
            config.appOrigin,
            blockTokenFor(organizationId, invitation.id, invitation.emailNormalized),
          ),
        });
      } catch (error) {
        return fail(error);
      }
    },

    async readInvitationBlock(token) {
      const block = provedBlock(token);
      if (block === null) return fail(new AuthError('AUTH_INVITATION_INVALID'));
      try {
        const org = await store.organization(block.organizationId, (tx) =>
          tx
            .selectFrom('organizations')
            .select('name')
            .where('organization_id', '=', block.organizationId)
            .executeTakeFirst(),
        );
        if (org === undefined) return fail(new AuthError('AUTH_INVITATION_INVALID'));
        return ok({ organizationId: block.organizationId, organizationName: org.name });
      } catch (error) {
        return fail(error);
      }
    },

    async blockInvitation(token) {
      const block = provedBlock(token);
      if (block === null) return fail(new AuthError('AUTH_INVITATION_INVALID'));
      const ids = {
        organizationId: ['org', block.organizationId],
        invitationId: ['inv', block.invitationId],
      } as const;
      try {
        await store.organization(block.organizationId, async (tx) => {
          await tx
            .insertInto('invitation_blocks')
            .values({ organization_id: block.organizationId, email_hmac: block.emailHmac })
            .onConflict((oc) => oc.columns(['organization_id', 'email_hmac']).doNothing())
            .execute();
          // The invitation that brought the link stops holding a seat. A resend keeps its
          // id, so this is the one row for the address.
          await tx
            .deleteFrom('invitations')
            .where('organization_id', '=', block.organizationId)
            .where('id', '=', block.invitationId)
            .execute();
        });
      } catch (error) {
        quietWarn(deps.logger, 'auth.invitation_block_failed', idFields(ids));
        return fail(error);
      }
      quietInfo(deps.logger, 'auth.invitation_blocked', idFields(ids));
      return ok(undefined);
    },

    async seatUsage(a) {
      try {
        const { used, tier } = await store.organization(a.organizationId, (tx) =>
          countUsed(tx, a.organizationId, null),
        );
        return Object.freeze({ used, limit: limitFor(storedTier(tier), 'org.seats') });
      } catch (error) {
        throw unavailable(error);
      }
    },
  } satisfies Invitations);
}
