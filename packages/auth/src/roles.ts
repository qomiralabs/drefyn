import type { Result } from '@drefyn/address';
import {
  DbError,
  withOrganization,
  withUser,
  type Database,
  type OrganizationSchema,
} from '@drefyn/db';
import { idOf, type IdOf, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { storedRole, type AccessContext } from './access.ts';
import type { AuthNoticeMailer, AuthSecurityNotice } from './email-change.ts';
import { AuthError, type AuthErrorCode } from './errors.ts';
import type { OrganizationStore } from './organizations.ts';
import { ORG_ROLES, PROJECT_ROLES, type OrgRole, type ProjectRole } from './permissions.ts';
import type { AuthLogger } from './rate-limiter.ts';
import {
  invitationRolesLost,
  keysGoWith,
  removalRefusal,
  roleChangeRefusal,
} from './role-rules.ts';
import {
  asId,
  fail,
  idFields,
  ok,
  quietInfo,
  quietWarn,
  type SessionStore,
} from './session-support.ts';
import { checkRecentAuth } from './step-up.ts';

export interface RoleChangeSummary {
  readonly from: OrgRole;
  readonly to: OrgRole;
  readonly revokedKeyIds: readonly IdOf<'key'>[];
  readonly deletedInvitations: number;
}

export interface RemovalSummary {
  readonly revokedKeyIds: readonly IdOf<'key'>[];
  readonly deletedInvitations: number;
}

export interface Roles {
  // Removal and demotion to member take every key the person made: there is no keep option,
  // because a key that outlives its maker's access is the risk this exists for.
  changeRole(
    a: AccessContext,
    member: IdOf<'mem'>,
    role: OrgRole,
  ): Promise<Result<RoleChangeSummary, AuthError>>;
  removeMember(a: AccessContext, member: IdOf<'mem'>): Promise<Result<RemovalSummary, AuthError>>;
  // null takes the project role away, so the default project role applies again.
  setProjectRole(
    a: AccessContext,
    member: IdOf<'mem'>,
    project: ProjectId,
    role: ProjectRole | null,
  ): Promise<Result<void, AuthError>>;
  // The role the person holds on one project as stored now, or null for none.
  projectRole(a: AccessContext, project: ProjectId): Promise<ProjectRole | null>;
}

export type RoleStore = Pick<SessionStore, 'user'> &
  Pick<OrganizationStore, 'organization' | 'organizationAs'>;

export interface RolesDeps {
  readonly db?: Database;
  readonly store?: RoleStore;
  readonly logger: AuthLogger;
  readonly mailer: AuthNoticeMailer;
}

class Refused extends Error {
  readonly code: AuthErrorCode;
  constructor(code: AuthErrorCode) {
    super(code);
    this.code = code;
  }
}

// The code allowed it and a database guard did not: logged as a breach of the invariant.
class GuardRefused extends Error {}

const isRole = (value: unknown): value is OrgRole =>
  typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
const isProjectRole = (value: unknown): value is ProjectRole =>
  typeof value === 'string' && (PROJECT_ROLES as readonly string[]).includes(value);

// 42501 from a restrictive policy, raw inside the work or mapped by the pool.
function refusedByPolicy(error: unknown): boolean {
  if (error instanceof DbError) return error.code === 'DB_RLS_VIOLATION';
  return Reflect.get(Object(error), 'code') === '42501';
}

interface Target {
  readonly id: string;
  readonly userId: string;
  readonly role: OrgRole;
  readonly name: string;
}

interface Done {
  readonly revokedKeyIds: readonly IdOf<'key'>[];
  readonly deletedInvitations: number;
  readonly owners: readonly string[];
  readonly name: string;
  readonly at: Date;
}

type Tx = Transaction<OrganizationSchema>;

// Every role change and removal waits here, and on the lock invite takes, so the owner count
// read after it sees every change committed before. No key update, not update: a key being
// created checks its organization foreign key with a key share lock, and a full update lock
// here would deadlock with that key while the code waits on its creator's membership.
async function lockOrganization(tx: Tx, organizationId: OrganizationId): Promise<void> {
  await tx
    .selectFrom('organizations')
    .select('organization_id')
    .where('organization_id', '=', organizationId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
}

async function readTarget(tx: Tx, member: string): Promise<Target> {
  const row = await tx
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['m.id', 'm.user_id', 'm.role', 'u.display_name', 'u.email'])
    .where('m.id', '=', member)
    .executeTakeFirst();
  if (row === undefined) throw new Refused('AUTH_NOT_FOUND');
  const name = row.display_name ?? '';
  return {
    id: row.id,
    userId: row.user_id,
    role: storedRole(row.role),
    name: name === '' ? row.email : name,
  };
}

// The role as stored now, not as the guard saw it at the start of the request.
async function readActor(tx: Tx, a: AccessContext): Promise<OrgRole> {
  const row = await tx
    .selectFrom('memberships')
    .select(['id', 'role'])
    .where('user_id', '=', a.userId)
    .executeTakeFirst();
  if (row === undefined) throw new Refused('AUTH_FORBIDDEN');
  return storedRole(row.role);
}

async function otherOwners(tx: Tx, target: Target): Promise<number> {
  const row = await tx
    .selectFrom('memberships')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('role', '=', 'owner')
    .where('id', '<>', target.id)
    .executeTakeFirstOrThrow();
  return row.n;
}

// Taken before any key is revoked: a key made in flight holds this row for share, so the
// revoke below waits for it and then sees it.
async function lockTarget(tx: Tx, target: Target): Promise<void> {
  const row = await tx
    .selectFrom('memberships')
    .select('id')
    .where('id', '=', target.id)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new GuardRefused();
}

async function revokeKeys(tx: Tx, target: Target): Promise<IdOf<'key'>[]> {
  const rows = await tx
    .deleteFrom('api_keys')
    .where('created_by', '=', target.id)
    .returning('id')
    .execute();
  return rows.map((r) => idOf('key', r.id));
}

async function ownerAddresses(tx: Tx): Promise<string[]> {
  const rows = await tx
    .selectFrom('memberships as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select('u.email')
    .where('m.role', '=', 'owner')
    .execute();
  return rows.map((r) => r.email);
}

export function createRoles(deps: RolesDeps): Roles {
  const { db } = deps;
  let store: RoleStore;
  if (deps.store !== undefined) {
    store = deps.store;
  } else if (db !== undefined) {
    store = {
      user: (userId, work) => withUser(db, { userId }, work),
      organization: (organizationId, work) => withOrganization(db, { organizationId }, work),
      organizationAs: (organizationId, actorUserId, work) =>
        withOrganization(db, { organizationId, actorUserId }, work),
    };
  } else {
    throw new AuthError('AUTH_CONFIG_INVALID');
  }

  type Ids = Record<string, readonly ['org' | 'usr' | 'mem' | 'prj', unknown]>;

  function settle<T>(error: unknown, ids: Ids, event: string): Result<T, AuthError> {
    if (error instanceof Refused) {
      quietInfo(deps.logger, event, { ...idFields(ids), outcome: error.code });
      return fail(new AuthError(error.code));
    }
    if (error instanceof GuardRefused || refusedByPolicy(error)) {
      quietWarn(deps.logger, 'auth.role_guard_refused', idFields(ids));
      return fail(new AuthError('AUTH_FORBIDDEN'));
    }
    return fail(error);
  }

  // After the commit. A failed send is logged and never undoes the change, and each owner is
  // tried on their own, so one bad address cannot keep the news from the others.
  async function tell(owners: readonly string[], notice: AuthSecurityNotice, ids: Ids) {
    for (const to of owners) {
      try {
        await deps.mailer.sendSecurityNotice(to, notice);
      } catch {
        quietWarn(deps.logger, 'auth.member_notice_failed', idFields(ids));
      }
    }
  }

  // Before any lock or write. A session taken over or left open must not be able to add an
  // owner, change what someone can reach or revoke their keys.
  async function refuseStale(a: AccessContext, ids: Ids, event: string) {
    const recent = await checkRecentAuth(store, a);
    if (!recent.ok) quietInfo(deps.logger, event, { ...idFields(ids), outcome: recent.error.code });
    return recent;
  }

  return Object.freeze({
    async changeRole(a, member, role) {
      if (asId('mem', member) === null || !isRole(role)) {
        return fail(new AuthError('AUTH_INPUT_INVALID'));
      }
      const ids: Ids = {
        organizationId: ['org', a.organizationId],
        userId: ['usr', a.userId],
        membershipId: ['mem', member],
      };
      const recent = await refuseStale(a, ids, 'auth.role_change_refused');
      if (!recent.ok) return recent;
      let from: OrgRole;
      let done: Done | null;
      try {
        ({ from, done } = await store.organizationAs(a.organizationId, a.userId, async (tx) => {
          await lockOrganization(tx, a.organizationId);
          const target = await readTarget(tx, member);
          const actorRole = await readActor(tx, a);
          const self = target.userId === a.userId;
          const lowersOwner = target.role === 'owner' && role !== 'owner';
          const refusal = roleChangeRefusal({
            actorRole,
            self,
            from: target.role,
            to: role,
            otherOwners: lowersOwner ? await otherOwners(tx, target) : 1,
          });
          if (refusal !== null) throw new Refused(refusal);
          if (target.role === role) return { from: target.role, done: null };
          await lockTarget(tx, target);
          const revokedKeyIds = keysGoWith(role) ? await revokeKeys(tx, target) : [];
          // Rows are for members only, and one kept here would come back on a later demotion
          // as a grant nobody chose.
          if (target.role === 'member') {
            await tx.deleteFrom('project_roles').where('membership_id', '=', target.id).execute();
          }
          const lost = invitationRolesLost(role);
          let pending = tx.deleteFrom('invitations').where('invited_by', '=', target.id);
          // A member can grant nothing, so every invitation goes.
          if (lost.length < ORG_ROLES.length) pending = pending.where('role', 'in', lost);
          const deleted = lost.length === 0 ? [] : await pending.returning('id').execute();
          const changed = await tx
            .updateTable('memberships')
            .set({ role, updated_at: sql<Date>`now()` })
            .where('id', '=', target.id)
            .returning(['id', sql<Date>`now()`.as('at')])
            .executeTakeFirst();
          if (changed === undefined) throw new GuardRefused();
          return {
            from: target.role,
            done: {
              revokedKeyIds,
              deletedInvitations: deleted.length,
              owners: await ownerAddresses(tx),
              name: target.name,
              at: changed.at,
            },
          };
        }));
      } catch (error) {
        return settle(error, ids, 'auth.role_change_refused');
      }
      if (done === null) {
        return ok(Object.freeze({ from, to: role, revokedKeyIds: [], deletedInvitations: 0 }));
      }
      quietInfo(deps.logger, 'auth.role_changed', {
        ...idFields(ids),
        from,
        to: role,
        revokedKeys: done.revokedKeyIds.length,
        deletedInvitations: done.deletedInvitations,
      });
      const about = {
        organizationId: a.organizationId,
        membershipId: member,
        memberName: done.name,
        at: done.at,
      };
      if (role === 'owner') await tell(done.owners, { kind: 'owner_added', ...about }, ids);
      if (done.revokedKeyIds.length > 0) {
        await tell(
          done.owners,
          { kind: 'member_keys_revoked', ...about, revokedKeys: done.revokedKeyIds.length },
          ids,
        );
      }
      return ok(
        Object.freeze({
          from,
          to: role,
          revokedKeyIds: Object.freeze([...done.revokedKeyIds]),
          deletedInvitations: done.deletedInvitations,
        }),
      );
    },

    async removeMember(a, member) {
      if (asId('mem', member) === null) return fail(new AuthError('AUTH_INPUT_INVALID'));
      const ids: Ids = {
        organizationId: ['org', a.organizationId],
        userId: ['usr', a.userId],
        membershipId: ['mem', member],
      };
      const recent = await refuseStale(a, ids, 'auth.member_remove_refused');
      if (!recent.ok) return recent;
      let done: Done;
      try {
        done = await store.organizationAs(a.organizationId, a.userId, async (tx) => {
          await lockOrganization(tx, a.organizationId);
          const target = await readTarget(tx, member);
          const actorRole = await readActor(tx, a);
          const refusal = removalRefusal({
            actorRole,
            self: target.userId === a.userId,
            target: target.role,
            otherOwners: target.role === 'owner' ? await otherOwners(tx, target) : 1,
          });
          if (refusal !== null) throw new Refused(refusal);
          await lockTarget(tx, target);
          // Before the membership goes: its delete would null created_by and lose the link.
          const revokedKeyIds = await revokeKeys(tx, target);
          const pending = await tx
            .selectFrom('invitations')
            .select(sql<number>`count(*)::int`.as('n'))
            .where('invited_by', '=', target.id)
            .executeTakeFirstOrThrow();
          // The membership's pending invitations and project roles go with it by cascade.
          const removed = await tx
            .deleteFrom('memberships')
            .where('id', '=', target.id)
            .returning(['id', sql<Date>`now()`.as('at')])
            .executeTakeFirst();
          if (removed === undefined) throw new GuardRefused();
          return {
            revokedKeyIds,
            deletedInvitations: pending.n,
            owners: await ownerAddresses(tx),
            name: target.name,
            at: removed.at,
          };
        });
      } catch (error) {
        return settle(error, ids, 'auth.member_remove_refused');
      }
      quietInfo(deps.logger, 'auth.member_removed', {
        ...idFields(ids),
        revokedKeys: done.revokedKeyIds.length,
        deletedInvitations: done.deletedInvitations,
      });
      await tell(
        done.owners,
        {
          kind: 'member_removed',
          organizationId: a.organizationId,
          membershipId: member,
          memberName: done.name,
          revokedKeys: done.revokedKeyIds.length,
          at: done.at,
        },
        ids,
      );
      return ok(
        Object.freeze({
          revokedKeyIds: Object.freeze([...done.revokedKeyIds]),
          deletedInvitations: done.deletedInvitations,
        }),
      );
    },

    async setProjectRole(a, member, project, role) {
      if (
        asId('mem', member) === null ||
        asId('prj', project) === null ||
        (role !== null && !isProjectRole(role))
      ) {
        return fail(new AuthError('AUTH_INPUT_INVALID'));
      }
      const ids: Ids = {
        organizationId: ['org', a.organizationId],
        userId: ['usr', a.userId],
        membershipId: ['mem', member],
        projectId: ['prj', project],
      };
      const recent = await refuseStale(a, ids, 'auth.project_role_refused');
      if (!recent.ok) return recent;
      try {
        await store.organizationAs(a.organizationId, a.userId, async (tx) => {
          const actorRole = await readActor(tx, a);
          if (actorRole === 'member') throw new Refused('AUTH_FORBIDDEN');
          const target = await readTarget(tx, member);
          // Owners and admins are project admins everywhere; a row would mean nothing.
          if (target.role !== 'member') throw new Refused('AUTH_INPUT_INVALID');
          const found = await tx
            .selectFrom('projects')
            .select('id')
            .where('id', '=', project)
            .executeTakeFirst();
          if (found === undefined) throw new Refused('AUTH_INPUT_INVALID');
          if (role === null) {
            await tx
              .deleteFrom('project_roles')
              .where('membership_id', '=', target.id)
              .where('target_project_id', '=', project)
              .execute();
            return;
          }
          await tx
            .insertInto('project_roles')
            .values({
              organization_id: a.organizationId,
              membership_id: target.id,
              target_project_id: project,
              role,
            })
            .onConflict((oc) =>
              oc
                .columns(['organization_id', 'membership_id', 'target_project_id'])
                .doUpdateSet({ role, updated_at: sql<Date>`now()` }),
            )
            .returning('role')
            .executeTakeFirstOrThrow();
        });
      } catch (error) {
        return settle(error, ids, 'auth.project_role_refused');
      }
      quietInfo(deps.logger, 'auth.project_role_set', { ...idFields(ids), role: role ?? 'none' });
      return ok(undefined);
    },

    async projectRole(a, project) {
      if (asId('prj', project) === null) return null;
      return store.organization(a.organizationId, async (tx) => {
        const found = await tx
          .selectFrom('projects')
          .select('id')
          .where('id', '=', project)
          .executeTakeFirst();
        if (found === undefined) return null;
        const member = await tx
          .selectFrom('memberships')
          .select(['id', 'role', 'default_project_role'])
          .where('user_id', '=', a.userId)
          .executeTakeFirst();
        if (member === undefined) return null;
        if (storedRole(member.role) !== 'member') return 'admin';
        const row = await tx
          .selectFrom('project_roles')
          .select('role')
          .where('membership_id', '=', member.id)
          .where('target_project_id', '=', project)
          .executeTakeFirst();
        const stored: unknown = row?.role ?? member.default_project_role;
        return isProjectRole(stored) ? stored : null;
      });
    },
  } satisfies Roles);
}
