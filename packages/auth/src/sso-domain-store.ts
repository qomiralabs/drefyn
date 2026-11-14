import type { Result } from '@drefyn/address';
import {
  withAuth,
  withOrganization,
  withUser,
  type AuthDatabase,
  type Database,
  type OrganizationSchema,
} from '@drefyn/db';
import { idOf, type OrganizationId, type UserId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import type { AccessContext } from './access.ts';
import type { SsoConnectionId, SsoDomainId } from './auth-events.ts';
import { AuthError } from './errors.ts';
import type { SessionStore } from './session-support.ts';
import { checkRecentAuth } from './step-up.ts';

export interface StoredSsoDomain {
  readonly id: string;
  readonly connectionId: string;
  readonly domain: string;
  readonly tokenHash: Buffer;
  readonly verifiedAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly failedChecks: number;
  // Database time of the last write to the row.
  readonly updatedAt: Date;
}

export interface VerifiedSsoDomainRef {
  readonly organizationId: OrganizationId;
  readonly domain: string;
}

export interface SsoDomainMember {
  readonly role: unknown;
  readonly defaultProjectRole: unknown;
}

// One organization transaction's worth of statements, all under its tenant policy.
export interface SsoDomainOps {
  member(userId: UserId): Promise<SsoDomainMember | null>;
  planTier(): Promise<unknown>;
  connectionExists(connectionId: SsoConnectionId): Promise<boolean>;
  // Locks the row, so two claims of one domain take turns.
  lockDomainByName(domain: string): Promise<StoredSsoDomain | null>;
  domainById(domainId: SsoDomainId): Promise<StoredSsoDomain | null>;
  // null when a claim of the same domain committed first.
  insertDomain(input: {
    readonly connectionId: SsoConnectionId;
    readonly domain: string;
    readonly tokenHash: Buffer;
  }): Promise<StoredSsoDomain | null>;
  reissueToken(domainId: string, connectionId: string, tokenHash: Buffer): Promise<StoredSsoDomain>;
  // null when the token changed since it was read. Throws DB_UNIQUE_VIOLATION when another
  // organization holds the domain verified.
  markVerified(domainId: string, tokenHash: Buffer): Promise<StoredSsoDomain | null>;
  // The verified row for this domain if a day has passed since its last check.
  dueDomain(domain: string): Promise<StoredSsoDomain | null>;
  // Each is null when the row is no longer as it was read: another server checked it, or
  // the token or the count moved.
  recordFound(
    domainId: string,
    tokenHash: Buffer,
    failedChecks: number,
  ): Promise<StoredSsoDomain | null>;
  recordMiss(
    domainId: string,
    tokenHash: Buffer,
    failedChecks: number,
    strikes: number,
  ): Promise<StoredSsoDomain | null>;
  ownerAddresses(): Promise<readonly string[]>;
}

export interface SsoDomainRepository {
  recentAuth(ctx: AccessContext): Promise<Result<void, AuthError>>;
  // Through the sign in role, the one that sees verified domains across organizations.
  verifiedElsewhere(organizationId: OrganizationId, domain: string): Promise<boolean>;
  // Every verified domain in (organization, domain) order, after the given one.
  verifiedPage(
    after: VerifiedSsoDomainRef | null,
    limit: number,
  ): Promise<readonly VerifiedSsoDomainRef[]>;
  inOrganization<T>(
    organizationId: OrganizationId,
    actorUserId: UserId | null,
    work: (ops: SsoDomainOps) => Promise<T>,
  ): Promise<T>;
}

export type SsoDomainSqlStore = Pick<SessionStore, 'user' | 'auth'> & {
  organization<T>(
    organizationId: OrganizationId,
    work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
  ): Promise<T>;
  organizationAs<T>(
    organizationId: OrganizationId,
    actorUserId: UserId,
    work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
  ): Promise<T>;
};

export interface SsoDomainRepositoryDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: SsoDomainSqlStore;
}

const COLUMNS = [
  'id',
  'connection_id',
  'domain',
  'txt_token_hash',
  'verified_at',
  'last_checked_at',
  'failed_checks',
  'updated_at',
] as const;

interface Row {
  readonly id: string;
  readonly connection_id: string;
  readonly domain: string;
  readonly txt_token_hash: Buffer;
  readonly verified_at: Date | null;
  readonly last_checked_at: Date | null;
  readonly failed_checks: number;
  readonly updated_at: Date;
}

const stored = (row: Row): StoredSsoDomain => ({
  id: row.id,
  connectionId: row.connection_id,
  domain: row.domain,
  tokenHash: row.txt_token_hash,
  verifiedAt: row.verified_at,
  lastCheckedAt: row.last_checked_at,
  failedChecks: row.failed_checks,
  updatedAt: row.updated_at,
});

const maybe = (row: Row | undefined) => (row === undefined ? null : stored(row));

// A day from the last check, by database time, so servers with drifting clocks agree.
const due = sql<boolean>`(last_checked_at is null or last_checked_at <= now() - interval '1 day')`;

function opsFor(tx: Transaction<OrganizationSchema>, organizationId: OrganizationId): SsoDomainOps {
  const domains = () => tx.selectFrom('sso_domains').select(COLUMNS);
  return {
    async member(userId) {
      const row = await tx
        .selectFrom('memberships')
        .select(['role', 'default_project_role'])
        .where('user_id', '=', userId)
        .executeTakeFirst();
      return row === undefined
        ? null
        : { role: row.role, defaultProjectRole: row.default_project_role };
    },
    async planTier() {
      const row = await tx
        .selectFrom('organizations')
        .select('plan_tier')
        .where('organization_id', '=', organizationId)
        .executeTakeFirst();
      return row?.plan_tier;
    },
    async connectionExists(connectionId) {
      const row = await tx
        .selectFrom('sso_connections')
        .select('id')
        .where('id', '=', connectionId)
        .executeTakeFirst();
      return row !== undefined;
    },
    async lockDomainByName(domain) {
      return maybe(await domains().where('domain', '=', domain).forUpdate().executeTakeFirst());
    },
    async domainById(domainId) {
      return maybe(await domains().where('id', '=', domainId).executeTakeFirst());
    },
    async insertDomain({ connectionId, domain, tokenHash }) {
      const row = await tx
        .insertInto('sso_domains')
        .values({
          organization_id: organizationId,
          connection_id: connectionId,
          domain,
          txt_token_hash: tokenHash,
        })
        .onConflict((oc) => oc.columns(['organization_id', 'domain']).doNothing())
        .returning(COLUMNS)
        .executeTakeFirst();
      return maybe(row);
    },
    async reissueToken(domainId, connectionId, tokenHash) {
      const row = await tx
        .updateTable('sso_domains')
        .set({
          connection_id: connectionId,
          txt_token_hash: tokenHash,
          failed_checks: 0,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', domainId)
        .returning(COLUMNS)
        .executeTakeFirstOrThrow();
      return stored(row);
    },
    async markVerified(domainId, tokenHash) {
      const row = await tx
        .updateTable('sso_domains')
        .set({
          verified_at: sql<Date>`coalesce(verified_at, now())`,
          last_checked_at: sql<Date>`now()`,
          failed_checks: 0,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', domainId)
        .where('txt_token_hash', '=', tokenHash)
        .returning(COLUMNS)
        .executeTakeFirst();
      return maybe(row);
    },
    async dueDomain(domain) {
      return maybe(
        await domains()
          .where('domain', '=', domain)
          .where('verified_at', 'is not', null)
          .where(due)
          .executeTakeFirst(),
      );
    },
    async recordFound(domainId, tokenHash, failedChecks) {
      const row = await tx
        .updateTable('sso_domains')
        .set({
          failed_checks: 0,
          last_checked_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', domainId)
        .where('verified_at', 'is not', null)
        .where('txt_token_hash', '=', tokenHash)
        .where('failed_checks', '=', failedChecks)
        .where(due)
        .returning(COLUMNS)
        .executeTakeFirst();
      return maybe(row);
    },
    async recordMiss(domainId, tokenHash, failedChecks, strikes) {
      const row = await tx
        .updateTable('sso_domains')
        .set({
          failed_checks: sql<number>`failed_checks + 1`,
          verified_at: sql<Date | null>`case when failed_checks + 1 >= ${strikes} then null else verified_at end`,
          last_checked_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
        })
        .where('id', '=', domainId)
        .where('verified_at', 'is not', null)
        .where('txt_token_hash', '=', tokenHash)
        .where('failed_checks', '=', failedChecks)
        .where(due)
        .returning(COLUMNS)
        .executeTakeFirst();
      return maybe(row);
    },
    async ownerAddresses() {
      const rows = await tx
        .selectFrom('memberships as m')
        .innerJoin('users as u', 'u.id', 'm.user_id')
        .select('u.email')
        .where('m.role', '=', 'owner')
        .orderBy('u.email')
        .execute();
      return rows.map((r) => r.email);
    },
  };
}

function sqlStore(deps: SsoDomainRepositoryDeps): SsoDomainSqlStore {
  if (deps.store !== undefined) return deps.store;
  const { db, authDb } = deps;
  if (db === undefined || authDb === undefined) throw new AuthError('AUTH_CONFIG_INVALID');
  return {
    user: (userId, work) => withUser(db, { userId }, work),
    auth: (work) => withAuth(authDb, work),
    organization: (organizationId, work) => withOrganization(db, { organizationId }, work),
    organizationAs: (organizationId, actorUserId, work) =>
      withOrganization(db, { organizationId, actorUserId }, work),
  };
}

export function createSsoDomainRepository(deps: SsoDomainRepositoryDeps): SsoDomainRepository {
  const store = sqlStore(deps);
  return Object.freeze({
    recentAuth: (ctx: AccessContext) => checkRecentAuth(store, ctx),
    async verifiedElsewhere(organizationId: OrganizationId, domain: string) {
      const row = await store.auth((tx) =>
        tx
          .selectFrom('sso_domains')
          .select('organization_id')
          .where('domain', '=', domain)
          .where('verified_at', 'is not', null)
          .where('organization_id', '<>', organizationId)
          .executeTakeFirst(),
      );
      return row !== undefined;
    },
    async verifiedPage(after: VerifiedSsoDomainRef | null, limit: number) {
      const rows = await store.auth((tx) => {
        let query = tx
          .selectFrom('sso_domains')
          .select(['organization_id', 'domain'])
          .where('verified_at', 'is not', null);
        if (after !== null) {
          query = query.where((eb) =>
            eb(
              eb.refTuple('organization_id', 'domain'),
              '>',
              eb.tuple(after.organizationId, after.domain),
            ),
          );
        }
        return query.orderBy('organization_id').orderBy('domain').limit(limit).execute();
      });
      return rows.map((r) => ({
        organizationId: idOf('org', r.organization_id),
        domain: r.domain,
      }));
    },
    inOrganization<T>(
      organizationId: OrganizationId,
      actorUserId: UserId | null,
      work: (ops: SsoDomainOps) => Promise<T>,
    ): Promise<T> {
      const run = (tx: Transaction<OrganizationSchema>) => work(opsFor(tx, organizationId));
      return actorUserId === null
        ? store.organization(organizationId, run)
        : store.organizationAs(organizationId, actorUserId, run);
    },
  });
}
