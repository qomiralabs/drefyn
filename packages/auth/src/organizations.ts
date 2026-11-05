import { randomInt } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
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
import { limitFor, type LimitValue, type Tier } from '@drefyn/entitlements';
import { idOf, type OrganizationId, type UserId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { grantAccess, storedRole, storedTier, type AccessContext } from './access.ts';
import type { AuthConfig } from './config.ts';
import { AuthError } from './errors.ts';
import {
  SLUG_SUFFIX_ALPHABET,
  SLUG_SUFFIX_LENGTH,
  parseOrganizationName,
  slugCandidate,
} from './organization-rules.ts';
import type { OrgRole } from './permissions.ts';
import { createRateLimiter, type AuthLogger, type RateLimiter } from './rate-limiter.ts';
import { countUsed } from './seat-count.ts';
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

// What the organization menu shows. Seats are null past the counted few.
export interface OrganizationSeats extends OrganizationSummary {
  readonly seats: { readonly used: number; readonly limit: LimitValue } | null;
}

// The two transaction kinds organizations use. Tests hand in scripted ones.
export interface OrganizationStore {
  user<T>(userId: UserId, work: (tx: Transaction<UserSchema>) => Promise<T>): Promise<T>;
  // Names nobody, so the database refuses every guarded write in it.
  organization<T>(
    organizationId: OrganizationId,
    work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
  ): Promise<T>;
  // Names the person acting. A key, an invitation or a membership written here must be theirs.
  organizationAs<T>(
    organizationId: OrganizationId,
    actorUserId: UserId,
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
  readonly newSlugSuffix?: () => string;
}

export interface CreatedOrganization {
  readonly access: AccessContext;
  // The server's choice, and the only place a caller learns it.
  readonly slug: string;
}

export interface EnsuredOrganization {
  readonly organizationId: OrganizationId;
  readonly slug: string;
  readonly reused: boolean;
}

export interface Organizations {
  createOrganization(
    s: SessionInfo,
    input: { readonly name: string },
  ): Promise<Result<CreatedOrganization, AuthError>>;
  listMyOrganizations(s: Pick<SessionInfo, 'userId'>): Promise<readonly OrganizationSummary[]>;
  // A user context cannot count another member, so each count takes its own organization
  // transaction, and only for organizations the person's own list just proved.
  listMyOrganizationSeats(a: AccessContext): Promise<readonly OrganizationSeats[]>;
  // For the operator command, which has a person but no session yet and is often run twice:
  // the organization this person already owns under this exact name, or a new one by the
  // same rules, limit and insert path as createOrganization.
  ensureOrganizationFor(
    userId: UserId,
    input: { readonly name: string },
  ): Promise<Result<EnsuredOrganization, AuthError>>;
}

class SlugTaken extends Error {}
const TAKEN = new SlugTaken('slug taken');

// With about 530,000 suffixes, five misses means something is wrong, not that a name is
// popular. Each retry rolls back first, so nothing is left to double up.
const SLUG_TRIES = 5;
const RETRY_WAIT_MS = 20;

// Each count is a transaction on a page load, so the menu stops counting here.
const SEAT_COUNTS_MAX = 25;

function randomSlugSuffix(): string {
  return Array.from({ length: SLUG_SUFFIX_LENGTH }, () =>
    SLUG_SUFFIX_ALPHABET.charAt(randomInt(SLUG_SUFFIX_ALPHABET.length)),
  ).join('');
}

export function createOrganizations(config: AuthConfig, deps: OrganizationsDeps): Organizations {
  if (!INITIAL_TIERS.has(deps.initialTier)) {
    throw new AuthError('AUTH_CONFIG_INVALID');
  }
  const initialTier = deps.initialTier;
  const store: OrganizationStore = deps.store ?? {
    user: (userId, work) => withUser(deps.db, { userId }, work),
    organization: (organizationId, work) => withOrganization(deps.db, { organizationId }, work),
    organizationAs: (organizationId, actorUserId, work) =>
      withOrganization(deps.db, { organizationId, actorUserId }, work),
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
  const nextSuffix = deps.newSlugSuffix ?? randomSlugSuffix;

  // The one way an organization is made. Its first owner is the acting user, so the
  // database's insert rules see the same person in every write.
  async function write(
    userId: UserId,
    name: string,
  ): Promise<Result<{ organizationId: OrganizationId; slug: string }, AuthError>> {
    const organizationId = nextId();
    const ids = { organizationId: ['org', organizationId], userId: ['usr', userId] } as const;
    const writeWith = (slug: string) =>
      store.organizationAs(organizationId, userId, async (tx) => {
        await tx
          .insertInto('organizations')
          .values({ organization_id: organizationId, name, plan_tier: initialTier })
          .execute();
        // No row back means another organization holds it; the throw rolls the
        // organization back with it.
        const held = await tx
          .insertInto('organization_slugs')
          .values({ slug, organization_id: organizationId })
          .onConflict((oc) => oc.column('slug').doNothing())
          .returning('slug')
          .executeTakeFirst();
        if (held === undefined) throw TAKEN;
        const member = await tx
          .insertInto('memberships')
          .values({ organization_id: organizationId, user_id: userId, role: 'owner' })
          .returning('id')
          .executeTakeFirstOrThrow();
        return member.id;
      });
    try {
      for (let attempt = 0; attempt < SLUG_TRIES; attempt += 1) {
        if (attempt > 0) await sleep(randomInt(RETRY_WAIT_MS * 2 ** attempt));
        const slug = slugCandidate(name, nextSuffix(), attempt);
        try {
          const membershipId = await writeWith(slug);
          quietInfo(
            deps.logger,
            'auth.organization_created',
            idFields({ ...ids, membershipId: ['mem', membershipId] }),
          );
          return ok({ organizationId, slug });
        } catch (error) {
          if (error !== TAKEN) throw error;
        }
      }
      throw TAKEN;
    } catch (error) {
      quietWarn(deps.logger, 'auth.organization_create_failed', idFields(ids));
      return fail(error);
    }
  }

  const nameIn = (input: unknown) =>
    parseOrganizationName((input as { name?: unknown } | undefined)?.name);

  async function insert(
    userId: UserId,
    input: unknown,
  ): Promise<Result<{ organizationId: OrganizationId; slug: string }, AuthError>> {
    const name = nameIn(input);
    if (!name.ok) return name;
    // Counted before the work and in its own transaction, so a refused or failed attempt
    // still counts and parallel attempts cannot all pass.
    try {
      await limiter.reserve('org_create', [userId]);
    } catch (error) {
      return fail(error);
    }
    return write(userId, name.value);
  }

  // Only owner counts: being an admin of a company's organization is no reason to hand a
  // new first run someone else's tenant. The oldest wins, since the form can make twins.
  const ownedWithName = (tx: Transaction<UserSchema>, name: string) =>
    tx
      .selectFrom('memberships as m')
      .innerJoin('organizations as o', 'o.organization_id', 'm.organization_id')
      .innerJoin('organization_slugs as sl', 'sl.organization_id', 'm.organization_id')
      .select(['o.organization_id', 'sl.slug'])
      .where('m.user_id', '=', sql<string>`app.current_user_id()`)
      .where('m.role', '=', 'owner')
      .where('o.name', '=', name)
      .orderBy('o.organization_id')
      .limit(1)
      .executeTakeFirst();

  function reused(
    userId: UserId,
    row: { readonly organization_id: string; readonly slug: string },
  ): Result<EnsuredOrganization, AuthError> {
    const organizationId = idOf('org', row.organization_id);
    quietInfo(
      deps.logger,
      'auth.organization_reused',
      idFields({ organizationId: ['org', organizationId], userId: ['usr', userId] }),
    );
    return ok({ organizationId, slug: row.slug, reused: true });
  }

  async function ensure(
    userId: UserId,
    input: unknown,
  ): Promise<Result<EnsuredOrganization, AuthError>> {
    const name = nameIn(input);
    if (!name.ok) return name;
    try {
      // Read first, so a rerun for a fresh link spends no limit and takes no lock.
      const owned = await store.user(userId, (tx) => ownedWithName(tx, name.value));
      if (owned !== undefined) return reused(userId, owned);
      await limiter.reserve('org_create', [userId]);
      // A row cannot be unique on owner and name, since the form may make twins, so a lock
      // per person stands in. It lives in this transaction and the write runs on a second
      // connection, because only a user context can see what the person owns. That needs a
      // pool of two; a smaller one times out and refuses instead of duplicating.
      return await store.user(userId, async (tx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`org_ensure:${userId}`}, 0))`.execute(
          tx,
        );
        const again = await ownedWithName(tx, name.value);
        if (again !== undefined) return reused(userId, again);
        const made = await write(userId, name.value);
        return made.ok ? ok({ ...made.value, reused: false }) : made;
      });
    } catch (error) {
      return fail(error);
    }
  }

  async function listMine(userId: UserId): Promise<readonly OrganizationSummary[]> {
    const rows = await store.user(userId, (tx) =>
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
  }

  async function seatsIn(organizationId: OrganizationId): Promise<OrganizationSeats['seats']> {
    const { used, tier } = await store.organization(organizationId, (tx) =>
      countUsed(tx, organizationId, null),
    );
    return Object.freeze({ used, limit: limitFor(storedTier(tier), 'org.seats') });
  }

  return Object.freeze({
    async createOrganization(s, input) {
      const made = await insert(s.userId, input);
      if (!made.ok) return made;
      return ok({
        slug: made.value.slug,
        access: grantAccess({
          organizationId: made.value.organizationId,
          userId: s.userId,
          sessionId: s.sessionId,
          role: 'owner',
          defaultProjectRole: null,
          tier: initialTier,
          authenticatedAt: s.authenticatedAt,
        }),
      });
    },

    ensureOrganizationFor: ensure,

    async listMyOrganizations(s) {
      try {
        return await listMine(s.userId);
      } catch (error) {
        throw unavailable(error);
      }
    },

    async listMyOrganizationSeats(a) {
      try {
        const mine = await listMine(a.userId);
        const counted: OrganizationSeats[] = [];
        for (const [index, organization] of mine.entries()) {
          const seats = index < SEAT_COUNTS_MAX ? await seatsIn(organization.organizationId) : null;
          counted.push(Object.freeze({ ...organization, seats }));
        }
        return Object.freeze(counted);
      } catch (error) {
        throw unavailable(error);
      }
    },
  } satisfies Organizations);
}
