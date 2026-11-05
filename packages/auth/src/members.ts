import type { Result } from '@drefyn/address';
import { withOrganization, withUser, type Database, type OrganizationSchema } from '@drefyn/db';
import { PRODUCTS, type Product } from '@drefyn/entitlements';
import { idOf, type IdOf, type ProjectId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { storedRole, type AccessContext } from './access.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import type { DefaultProjectRole } from './invitations.ts';
import { memberName } from './notices.ts';
import type { OrganizationStore } from './organizations.ts';
import { canAssign, type OrgRole, type ProjectRole } from './permissions.ts';
import type { AuthLogger } from './rate-limiter.ts';
import { asId, fail, idFields, ok, quietInfo } from './session-support.ts';
import { checkRecentAuth } from './step-up.ts';

export interface MemberSummary {
  readonly membershipId: IdOf<'mem'>;
  readonly name: string;
  // Personal data, so never logged. Column grants already limit what this role reads.
  readonly email: string;
  readonly role: OrgRole;
  readonly defaultProjectRole: DefaultProjectRole | null;
  readonly joinedAt: Date;
  // True on the row of the person asking.
  readonly self: boolean;
  readonly projectRoles: readonly {
    readonly projectId: ProjectId;
    readonly role: ProjectRole;
  }[];
}

export interface PendingInvitation {
  readonly invitationId: IdOf<'inv'>;
  readonly email: string;
  readonly role: OrgRole;
  readonly defaultProjectRole: DefaultProjectRole | null;
  readonly invitedBy: string;
  readonly expiresAt: Date;
  // By database time. An expired invitation uses no seat.
  readonly expired: boolean;
}

export interface MemberList {
  readonly members: readonly MemberSummary[];
  // Empty for anyone who cannot manage people: addresses of people who have not joined are
  // not a member's business.
  readonly invitations: readonly PendingInvitation[];
}

export interface ProjectSummary {
  readonly projectId: ProjectId;
  readonly name: string;
  readonly product: Product;
}

// A project this person may open, with what the shell needs to draw it.
export interface ReachableProject extends ProjectSummary {
  readonly slug: string;
  readonly readOnly: boolean;
}

export interface WithdrawnInvitation {
  readonly email: string;
  readonly role: OrgRole;
  readonly defaultProjectRole: DefaultProjectRole | null;
}

export interface Members {
  listMembers(a: AccessContext): Promise<Result<MemberList, AuthError>>;
  // For choosing projects, so only for people who hand out access.
  listProjects(a: AccessContext): Promise<Result<readonly ProjectSummary[], AuthError>>;
  // Every project of a product the person reads, plus the ones they hold a role on.
  listReachableProjects(a: AccessContext): Promise<Result<readonly ReachableProject[], AuthError>>;
  // Returns what a fresh invitation would need, for Undo.
  withdrawInvitation(
    a: AccessContext,
    invitation: IdOf<'inv'>,
  ): Promise<Result<WithdrawnInvitation, AuthError>>;
  // null means no project until someone chooses.
  setDefaultProjectRole(
    a: AccessContext,
    member: IdOf<'mem'>,
    role: DefaultProjectRole | null,
  ): Promise<Result<void, AuthError>>;
}

export interface MembersDeps {
  readonly db?: Database;
  readonly store?: OrganizationStore;
  readonly logger: AuthLogger;
}

// The list is a page of one organization, so the cap only stops an unbounded read.
const LIST_MAX = 1000;
const DEFAULT_ROLES: ReadonlySet<unknown> = new Set(['editor', 'viewer']);

class Refused extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

type Tx = Transaction<OrganizationSchema>;

const asDefaultRole = (value: unknown): DefaultProjectRole | null =>
  value === 'editor' || value === 'viewer' ? value : null;
const asProjectRole = (value: unknown): ProjectRole =>
  value === 'admin' || value === 'editor' ? value : 'viewer';
const asProduct = (value: unknown): Product =>
  value === 'studio' || value === 'status' ? value : 'docs';

// The role as stored now, not as the guard saw it at the start of the request.
async function readActor(tx: Tx, a: AccessContext): Promise<OrgRole | null> {
  const row = await tx
    .selectFrom('memberships')
    .select('role')
    .where('user_id', '=', a.userId)
    .executeTakeFirst();
  return row === undefined ? null : storedRole(row.role);
}

const refused = (error: unknown) =>
  fail<never>(error instanceof Refused ? new AuthError(error.code) : error);

export function createMembers(deps: MembersDeps): Members {
  const { db } = deps;
  const store: OrganizationStore | null =
    deps.store ??
    (db === undefined
      ? null
      : {
          user: (userId, work) => withUser(db, { userId }, work),
          organization: (organizationId, work) => withOrganization(db, { organizationId }, work),
          organizationAs: (organizationId, actorUserId, work) =>
            withOrganization(db, { organizationId, actorUserId }, work),
        });
  if (store === null) throw new AuthError('AUTH_CONFIG_INVALID');

  return Object.freeze({
    async listMembers(a) {
      const managing = a.permissions.includes('org.manage_members');
      try {
        const read = await store.organization(a.organizationId, async (tx) => {
          const members = await tx
            .selectFrom('memberships as m')
            .innerJoin('users as u', 'u.id', 'm.user_id')
            .select([
              'm.id',
              'm.user_id',
              'm.role',
              'm.default_project_role',
              'm.created_at',
              'u.display_name',
              'u.email',
            ])
            .orderBy('m.id')
            .limit(LIST_MAX)
            .execute();
          const roles = await tx
            .selectFrom('project_roles')
            .select(['membership_id', 'target_project_id', 'role'])
            .execute();
          const invitations = managing
            ? await tx
                .selectFrom('invitations as i')
                .innerJoin('memberships as m', 'm.id', 'i.invited_by')
                .innerJoin('users as u', 'u.id', 'm.user_id')
                .select([
                  'i.id',
                  'i.email_normalized',
                  'i.role',
                  'i.default_project_role',
                  'i.expires_at',
                  sql<boolean>`i.expires_at <= now()`.as('expired'),
                  'u.display_name',
                  'u.email',
                ])
                .orderBy('i.id')
                .limit(LIST_MAX)
                .execute()
            : [];
          return { members, roles, invitations };
        });
        return ok(
          Object.freeze({
            members: Object.freeze(
              read.members.map((row) => ({
                membershipId: idOf('mem', row.id),
                name: memberName(row.display_name, row.email),
                email: row.email,
                role: storedRole(row.role),
                defaultProjectRole: asDefaultRole(row.default_project_role),
                joinedAt: row.created_at,
                self: row.user_id === a.userId,
                projectRoles: read.roles
                  .filter((role) => role.membership_id === row.id)
                  .map((role) => ({
                    projectId: idOf('prj', role.target_project_id),
                    role: asProjectRole(role.role),
                  })),
              })),
            ),
            invitations: Object.freeze(
              read.invitations.map((row) => ({
                invitationId: idOf('inv', row.id),
                email: row.email_normalized,
                role: storedRole(row.role),
                defaultProjectRole: asDefaultRole(row.default_project_role),
                invitedBy: memberName(row.display_name, row.email),
                expiresAt: row.expires_at,
                expired: row.expired,
              })),
            ),
          }),
        );
      } catch (error) {
        return fail(error);
      }
    },

    async listReachableProjects(a) {
      const products = PRODUCTS.filter((product) => a.permissions.includes(`${product}.read`));
      try {
        const rows = await store.organization(a.organizationId, (tx) =>
          tx
            .selectFrom('projects as p')
            .select(['p.id', 'p.slug', 'p.name', 'p.product', 'p.read_only_since'])
            .where('p.organization_id', '=', a.organizationId)
            .where((eb) =>
              eb.or([
                ...(products.length === 0 ? [] : [eb('p.product', 'in', products)]),
                eb.exists(
                  eb
                    .selectFrom('project_roles as r')
                    .innerJoin('memberships as m', (join) =>
                      join
                        .onRef('m.organization_id', '=', 'r.organization_id')
                        .onRef('m.id', '=', 'r.membership_id'),
                    )
                    .select('r.role')
                    .whereRef('r.target_project_id', '=', 'p.id')
                    .where('m.user_id', '=', a.userId),
                ),
              ]),
            )
            .orderBy('p.name')
            .orderBy('p.id')
            .limit(LIST_MAX)
            .execute(),
        );
        return ok(
          Object.freeze(
            rows.map((row) =>
              Object.freeze({
                projectId: idOf('prj', row.id),
                slug: row.slug,
                name: row.name,
                product: asProduct(row.product),
                readOnly: row.read_only_since !== null,
              }),
            ),
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },

    async listProjects(a) {
      if (
        !a.permissions.includes('org.manage_members') &&
        !a.permissions.includes('org.manage_api_keys')
      ) {
        return fail(new AuthError('AUTH_FORBIDDEN'));
      }
      try {
        const rows = await store.organization(a.organizationId, (tx) =>
          tx
            .selectFrom('projects')
            .select(['id', 'name', 'product'])
            .orderBy('name')
            .limit(LIST_MAX)
            .execute(),
        );
        return ok(
          Object.freeze(
            rows.map((row) => ({
              projectId: idOf('prj', row.id),
              name: row.name,
              product: asProduct(row.product),
            })),
          ),
        );
      } catch (error) {
        return fail(error);
      }
    },

    async withdrawInvitation(a, invitation) {
      if (asId('inv', invitation) === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      if (!a.permissions.includes('org.manage_members')) {
        return fail(new AuthError('AUTH_FORBIDDEN'));
      }
      try {
        const done = await store.organizationAs(a.organizationId, a.userId, async (tx) => {
          const actor = await readActor(tx, a);
          if (actor === null || actor === 'member') throw new Refused('AUTH_FORBIDDEN');
          const row = await tx
            .selectFrom('invitations')
            .select(['email_normalized', 'role', 'default_project_role'])
            .where('id', '=', invitation)
            .executeTakeFirst();
          if (row === undefined) throw new Refused('AUTH_NOT_FOUND');
          const role = storedRole(row.role);
          // Only someone who could send it may take it back.
          if (!canAssign(actor, role)) throw new Refused('AUTH_FORBIDDEN');
          const gone = await tx
            .deleteFrom('invitations')
            .where('id', '=', invitation)
            .returning('id')
            .executeTakeFirst();
          if (gone === undefined) throw new Refused('AUTH_NOT_FOUND');
          return {
            email: row.email_normalized,
            role,
            defaultProjectRole: asDefaultRole(row.default_project_role),
          };
        });
        quietInfo(
          deps.logger,
          'auth.invitation_withdrawn',
          idFields({
            organizationId: ['org', a.organizationId],
            userId: ['usr', a.userId],
            invitationId: ['inv', invitation],
          }),
        );
        return ok(Object.freeze(done));
      } catch (error) {
        return refused(error);
      }
    },

    async setDefaultProjectRole(a, member, role) {
      if (asId('mem', member) === null || (role !== null && !DEFAULT_ROLES.has(role))) {
        return fail(new AuthError('AUTH_INPUT_INVALID'));
      }
      if (!a.permissions.includes('org.manage_members')) {
        return fail(new AuthError('AUTH_FORBIDDEN'));
      }
      const stale = await checkRecentAuth(store, a);
      if (!stale.ok) return stale;
      try {
        await store.organizationAs(a.organizationId, a.userId, async (tx) => {
          const actor = await readActor(tx, a);
          if (actor === null || actor === 'member') throw new Refused('AUTH_FORBIDDEN');
          const target = await tx
            .selectFrom('memberships as m')
            .select(['m.id', 'm.role'])
            .where('m.id', '=', member)
            .executeTakeFirst();
          if (target === undefined) throw new Refused('AUTH_NOT_FOUND');
          // Owners and admins are project admins everywhere; the value would mean nothing.
          if (storedRole(target.role) !== 'member') throw new Refused('AUTH_INPUT_INVALID');
          await tx
            .updateTable('memberships')
            .set({ default_project_role: role, updated_at: sql<Date>`now()` })
            .where('id', '=', member)
            .returning('id')
            .executeTakeFirstOrThrow();
        });
      } catch (error) {
        return refused(error);
      }
      quietInfo(
        deps.logger,
        'auth.default_project_role_set',
        idFields({
          organizationId: ['org', a.organizationId],
          userId: ['usr', a.userId],
          membershipId: ['mem', member],
        }),
      );
      return ok(undefined);
    },
  } satisfies Members);
}
