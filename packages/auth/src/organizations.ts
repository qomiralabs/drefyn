import type { Result } from '@drefyn/address';
import {
  newId,
  withOrganization,
  withUser,
  type AuthDatabase,
  type Database,
  type OrganizationSchema,
  type UserSchema,
} from '@drefyn/db';
import type { Tier } from '@drefyn/entitlements';
import { idOf, type OrganizationId, type UserId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { grantAccess, storedRole, storedTier, type AccessContext } from './access.ts';
import type { AuthConfig } from './config.ts';
import { AuthError } from './errors.ts';
import { parseOrganizationName, parseSlug } from './organization-rules.ts';
import type { OrgRole } from './permissions.ts';
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

// The only tiers an organization starts on. Paid tiers come from billing afterwards.
export type InitialTier = Extract<Tier, 'self_hosted' | 'free'>;
const INITIAL_TIERS: ReadonlySet<unknown> = new Set(['self_hosted', 'free']);

export interface OrganizationSummary {
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly slug: string;
  readonly role: OrgRole;
  readonly tier: Tier;
  readonly readOnlySince: Date | null;
}

// The two transaction kinds organizations use. Tests hand in scripted ones.
export interface OrganizationStore {
  user<T>(userId: UserId, work: (tx: Transaction<UserSchema>) => Promise<T>): Promise<T>;
  organization<T>(
    organizationId: OrganizationId,
    work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
  ): Promise<T>;
}

export interface OrganizationsDeps {
  readonly db: Database;
  readonly authDb: AuthDatabase;
  readonly logger: AuthLogger;
  // self_hosted for the self host bootstrap, free for hosted signup. The caller knows which
  // install it is; nothing in a request may choose.
  readonly initialTier: InitialTier;
  readonly limiter?: RateLimiter;
  readonly store?: OrganizationStore;
  readonly newOrganizationId?: () => OrganizationId;
}

export interface Organizations {
  createOrganization(
    s: SessionInfo,
    input: { readonly name: string; readonly slug: string },
  ): Promise<Result<AccessContext, AuthError>>;
  listMyOrganizations(s: SessionInfo): Promise<readonly OrganizationSummary[]>;
}

class SlugTaken extends Error {}
const TAKEN = new SlugTaken('slug taken');

export function createOrganizations(config: AuthConfig, deps: OrganizationsDeps): Organizations {
  if (!INITIAL_TIERS.has(deps.initialTier)) {
    throw new AuthError('AUTH_CONFIG_INVALID');
  }
  const initialTier = deps.initialTier;
  const store: OrganizationStore = deps.store ?? {
    user: (userId, work) => withUser(deps.db, { userId }, work),
    organization: (organizationId, work) => withOrganization(deps.db, { organizationId }, work),
  };
  const limiter =
    deps.limiter ??
    createRateLimiter({
      db: deps.authDb,
      keys: config.keys,
      limits: config.rateLimits,
      logger: deps.logger,
    });
  const nextId = deps.newOrganizationId ?? (() => newId('org'));

  return Object.freeze({
    async createOrganization(s, input) {
      const name = parseOrganizationName((input as { name?: unknown } | undefined)?.name);
      if (!name.ok) return name;
      const slug = parseSlug((input as { slug?: unknown } | undefined)?.slug);
      if (!slug.ok) return slug;
      // Counted before the work and in its own transaction, so a refused or failed attempt
      // still counts and parallel attempts cannot all pass.
      try {
        await limiter.reserve('org_create', [s.userId]);
      } catch (error) {
        return fail(error);
      }
      const organizationId = nextId();
      const ids = { organizationId: ['org', organizationId], userId: ['usr', s.userId] } as const;
      let membershipId: string;
      try {
        membershipId = await store.organization(organizationId, async (tx) => {
          await tx
            .insertInto('organizations')
            .values({ organization_id: organizationId, name: name.value, plan_tier: initialTier })
            .execute();
          // No row back means another organization holds it; the throw rolls the
          // organization back with it.
          const held = await tx
            .insertInto('organization_slugs')
            .values({ slug: slug.value, organization_id: organizationId })
            .onConflict((oc) => oc.column('slug').doNothing())
            .returning('slug')
            .executeTakeFirst();
          if (held === undefined) throw TAKEN;
          const member = await tx
            .insertInto('memberships')
            .values({ organization_id: organizationId, user_id: s.userId, role: 'owner' })
            .returning('id')
            .executeTakeFirstOrThrow();
          return member.id;
        });
      } catch (error) {
        if (error === TAKEN) return fail(new AuthError('AUTH_SLUG_TAKEN'));
        quietWarn(deps.logger, 'auth.organization_create_failed', idFields(ids));
        return fail(error);
      }
      quietInfo(
        deps.logger,
        'auth.organization_created',
        idFields({ ...ids, membershipId: ['mem', membershipId] }),
      );
      return ok(
        grantAccess({
          organizationId,
          userId: s.userId,
          sessionId: s.sessionId,
          role: 'owner',
          defaultProjectRole: null,
          tier: initialTier,
          authenticatedAt: s.authenticatedAt,
        }),
      );
    },

    async listMyOrganizations(s) {
      try {
        const rows = await store.user(s.userId, (tx) =>
          tx
            .selectFrom('memberships as m')
            .innerJoin('organizations as o', 'o.organization_id', 'm.organization_id')
            .innerJoin('organization_slugs as sl', 'sl.organization_id', 'm.organization_id')
            .select([
              'o.organization_id',
              'o.name',
              'sl.slug',
              'm.role',
              'o.plan_tier',
              'o.read_only_since',
            ])
            .where('m.user_id', '=', sql<string>`app.current_user_id()`)
            .orderBy('o.name')
            .orderBy('o.organization_id')
            .execute(),
        );
        return Object.freeze(
          rows.map((row) =>
            Object.freeze({
              organizationId: idOf('org', row.organization_id),
              name: row.name,
              slug: row.slug,
              role: storedRole(row.role),
              tier: storedTier(row.plan_tier),
              readOnlySince: row.read_only_since,
            }),
          ),
        );
      } catch (error) {
        throw unavailable(error);
      }
    },
  } satisfies Organizations);
}
