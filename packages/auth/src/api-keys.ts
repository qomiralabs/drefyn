import type { Result } from '@drefyn/address';
import { PRODUCTS, type Product } from '@drefyn/entitlements';
import {
  newId,
  withAuth,
  withOrganization,
  withUser,
  type AuthDatabase,
  type Database,
  type OrganizationSchema,
} from '@drefyn/db';
import { idOf, type IdOf, type OrganizationId, type ProjectId, type UserId } from '@drefyn/tenancy';
import { sql, type RawBuilder, type SqlBool, type Transaction } from 'kysely';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { storedPermissions, type AccessContext } from './access.ts';
import type { AuthNoticeMailer, AuthSecurityNotice } from './email-change.ts';
import { AuthError } from './errors.ts';
import { constantTimeEqual, lengthPrefixed, sha256 } from './keys.ts';
import { parseOrganizationName } from './organization-rules.ts';
import { memberName, noticeEach, storedKeyName } from './notices.ts';
import type { OrganizationStore } from './organizations.ts';
import type { Permission } from './permissions.ts';
import type { AuthLogger } from './rate-limiter.ts';
import type { Scope, ScopeRegistry } from './scopes.ts';
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
import { SECRET_BYTES, encodeSecret, formatApiKey } from './tokens.ts';

export type ProjectScope = 'all' | 'listed';

// Everything about a key but its secret, which is shown once and never stored.
export interface ApiKeySummary {
  readonly keyId: IdOf<'key'>;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly displaySuffix: string;
  readonly scopes: readonly Scope[];
  readonly projectScope: ProjectScope;
  // Empty unless the scope is listed.
  readonly projectIds: readonly ProjectId[];
  // Null once the creator's membership is gone, and their keys are revoked by then.
  readonly createdBy: IdOf<'mem'> | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
  // Set once, by the database, and final.
  readonly revokedAt: Date | null;
}

export interface CreateApiKeyInput {
  readonly name: string;
  readonly scopes: readonly string[];
  // Said out loud, so an empty project list can never be read as every project.
  readonly projectScope: ProjectScope;
  readonly projectIds?: readonly ProjectId[];
  readonly expiresAt?: Date;
  readonly idempotencyKey: string;
}

export interface CreatedApiKey {
  readonly key: ApiKeySummary;
  // The whole key, drf_ak_..., returned this once.
  readonly secret: string;
  // Tells every owner. Never throws; meant to run after the response.
  readonly send: () => Promise<void>;
}

export interface RevokedApiKey {
  readonly key: ApiKeySummary;
  // True when an earlier call already revoked it. key.revokedAt is that first time.
  readonly alreadyRevoked: boolean;
  // Tells every owner, once. Does nothing when alreadyRevoked. Never throws.
  readonly send: () => Promise<void>;
}

export type ApiKeyState = 'live' | 'expired' | 'revoked';
export type ApiKeyLastUsed = 'any' | '7d' | '30d' | 'never';

export interface ListApiKeysInput {
  // 1 to 100 characters after NFKC. Matches the name only.
  readonly search?: string;
  // A key with any scope of these.
  readonly products?: readonly Product[];
  // 'former' stands for people no longer in the organization. At most 50.
  readonly createdBy?: readonly (IdOf<'mem'> | 'former')[];
  // Default 'any'.
  readonly lastUsed?: ApiKeyLastUsed;
  // Opaque, from nextCursor.
  readonly cursor?: string;
  // 1 to 100, default 50.
  readonly limit?: number;
}

export interface ListedApiKey extends ApiKeySummary {
  // By database time. Revoked wins over expired.
  readonly state: ApiKeyState;
  // Personal data, so never logged. Null when createdBy is null.
  readonly creatorName: string | null;
}

export interface ApiKeyPage {
  // Newest first.
  readonly items: readonly ListedApiKey[];
  readonly nextCursor: string | null;
  // After the filters, across all pages.
  readonly matched: number;
  // The rest are counts before any filter, for the page heading and the filter menus.
  readonly total: number;
  readonly live: number;
  readonly creators: readonly {
    readonly membershipId: IdOf<'mem'>;
    readonly name: string;
    readonly keys: number;
  }[];
  // Keys of people no longer in the organization.
  readonly formerKeys: number;
  readonly products: Readonly<Record<Product, number>>;
}

// A repeat of a request already made: the key it made, without the secret, which was shown
// once and is gone. A set revokedAt means the key is dead.
export class ApiKeyReplayError extends AuthError {
  readonly existing: ApiKeySummary;

  constructor(existing: ApiKeySummary) {
    super('AUTH_IDEMPOTENCY_REPLAY');
    this.existing = existing;
  }
}

export type ApiKeyStore = Pick<SessionStore, 'user' | 'auth'> & OrganizationStore;

export interface ApiKeysDeps {
  readonly db?: Database;
  readonly authDb?: AuthDatabase;
  readonly store?: ApiKeyStore;
  readonly scopes: ScopeRegistry;
  readonly logger: AuthLogger;
  readonly mailer: AuthNoticeMailer;
  readonly random?: (bytes: number) => Uint8Array;
  readonly newKeyId?: () => IdOf<'key'>;
}

export interface ApiKeys {
  createApiKey(
    a: AccessContext,
    input: CreateApiKeyInput,
  ): Promise<Result<CreatedApiKey, AuthError>>;
  revokeApiKey(a: AccessContext, id: IdOf<'key'>): Promise<Result<RevokedApiKey, AuthError>>;
  listApiKeys(a: AccessContext, input: ListApiKeysInput): Promise<Result<ApiKeyPage, AuthError>>;
}

const MAX_KEY_SCOPES = 32;
const MAX_PROJECTS = 100;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const MANAGE: Permission = 'org.manage_api_keys';
const READ: Permission = 'org.read';

const INPUT = z.strictObject({
  name: z.unknown(),
  scopes: z.array(z.string()).min(1).max(MAX_KEY_SCOPES),
  projectScope: z.enum(['all', 'listed']),
  projectIds: z.array(z.string()).max(MAX_PROJECTS).optional(),
  expiresAt: z.date().optional(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
});

const MAX_SEARCH = 100;
// Bounds the NFKC work on input that has not been measured yet.
const MAX_RAW_SEARCH = 1_000;
const MAX_CREATOR_FILTER = 50;
const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
const MAX_CURSOR = 128;
const CURSOR_VERSION = 'k1.';

// An empty list could mean no filter or no match, so a caller leaves the field out instead.
const LIST_INPUT = z.strictObject({
  search: z.string().max(MAX_RAW_SEARCH).optional(),
  products: z.array(z.enum(PRODUCTS)).min(1).max(PRODUCTS.length).optional(),
  createdBy: z.array(z.string()).min(1).max(MAX_CREATOR_FILTER).optional(),
  lastUsed: z.enum(['any', '7d', '30d', 'never']).optional(),
  cursor: z.string().max(MAX_CURSOR).optional(),
  limit: z.number().int().min(1).max(MAX_PAGE).optional(),
});

interface Parsed {
  readonly name: string;
  readonly scopes: readonly Scope[];
  readonly needs: readonly Permission[];
  readonly projectScope: ProjectScope;
  readonly projectIds: readonly ProjectId[];
  readonly expiresAt: Date | null;
  readonly idempotencyKey: string;
}

const INVALID = (): AuthError => new AuthError('AUTH_INPUT_INVALID');
const FORBIDDEN = (): AuthError => new AuthError('AUTH_FORBIDDEN');

const sortedUnique = <T extends string>(values: readonly T[]): T[] => [...new Set(values)].sort();

function parse(raw: unknown, registry: ScopeRegistry): Parsed | null {
  const input = INPUT.safeParse(raw);
  if (!input.success) return null;
  const v = input.data;
  // The name goes into the owners' notice, so it follows the organization name rules.
  const name = parseOrganizationName(v.name);
  if (!name.ok) return null;
  const needs: Permission[] = [];
  for (const scope of v.scopes) {
    const permission = registry.permissionFor(scope);
    if (permission === null) return null;
    needs.push(permission);
  }
  const projectIds: ProjectId[] = [];
  for (const value of v.projectIds ?? []) {
    const id = asId('prj', value);
    if (id === null) return null;
    projectIds.push(id);
  }
  if (v.projectScope === 'listed' ? projectIds.length === 0 : projectIds.length > 0) return null;
  if (v.expiresAt !== undefined && !(v.expiresAt.getTime() > Date.now())) return null;
  return {
    name: name.value,
    scopes: sortedUnique(v.scopes as Scope[]),
    needs: sortedUnique(needs),
    projectScope: v.projectScope,
    projectIds: sortedUnique(projectIds),
    expiresAt: v.expiresAt ?? null,
    idempotencyKey: v.idempotencyKey,
  };
}

function parseSearch(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return null;
  const search = raw.normalize('NFKC');
  // Postgres counts code points in a name, and a NUL or half a surrogate pair cannot be bound.
  const length = Array.from(search).length;
  if (length < 1 || length > MAX_SEARCH) return undefined;
  return search.isWellFormed() && !search.includes('\0') ? search : undefined;
}

const encodeCursor = (id: string) => Buffer.from(CURSOR_VERSION + id).toString('base64url');

// The encoding is checked by going back, so one position has exactly one cursor.
function parseCursor(raw: string | undefined): IdOf<'key'> | null | undefined {
  if (raw === undefined) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  if (!text.startsWith(CURSOR_VERSION)) return undefined;
  const id = asId('key', text.slice(CURSOR_VERSION.length));
  return id !== null && encodeCursor(id) === raw ? id : undefined;
}

interface ListQuery {
  readonly search: string | null;
  readonly products: readonly Product[] | null;
  readonly creators: readonly IdOf<'mem'>[];
  readonly former: boolean;
  readonly lastUsed: ApiKeyLastUsed;
  readonly after: IdOf<'key'> | null;
  readonly limit: number;
}

function parseList(raw: unknown): ListQuery | null {
  const input = LIST_INPUT.safeParse(raw);
  if (!input.success) return null;
  const v = input.data;
  const search = parseSearch(v.search);
  const after = parseCursor(v.cursor);
  if (search === undefined || after === undefined) return null;
  const creators: IdOf<'mem'>[] = [];
  let former = false;
  for (const value of v.createdBy ?? []) {
    if (value === 'former') {
      former = true;
      continue;
    }
    const id = asId('mem', value);
    if (id === null) return null;
    creators.push(id);
  }
  return {
    search,
    products: v.products ?? null,
    creators,
    former,
    lastUsed: v.lastUsed ?? 'any',
    after,
    limit: v.limit ?? DEFAULT_PAGE,
  };
}

const holdsAll = (held: readonly Permission[], needs: readonly Permission[]) =>
  held.includes(MANAGE) && needs.every((p) => held.includes(p));

// The canonical request, so a retry with the same key and the same meaning replays, and the
// same key with anything else is refused. Counts go in, so no list can borrow from the next.
function requestHash(p: Parsed): Buffer {
  return sha256(
    lengthPrefixed([
      'drefyn.api_key.create.v1',
      p.name,
      p.projectScope,
      String(p.scopes.length),
      ...p.scopes,
      String(p.projectIds.length),
      ...p.projectIds,
      p.expiresAt === null ? '' : p.expiresAt.toISOString(),
    ]),
  );
}

const PROJECT_SCOPES: ReadonlyMap<unknown, ProjectScope> = new Map([
  ['all', 'all'],
  ['listed', 'listed'],
]);

export function storedProjectScope(value: unknown): ProjectScope {
  const scope = PROJECT_SCOPES.get(value);
  if (scope === undefined) throw new Error('stored project scope is unknown');
  return scope;
}

// Everything a summary shows, and neither hash nor idempotency key.
const KEY_COLUMNS = [
  'id',
  'name',
  'display_suffix',
  'scopes',
  'project_scope',
  'created_by',
  'created_at',
  'expires_at',
  'last_used_at',
  'revoked_at',
] as const;

const STATES: ReadonlyMap<unknown, ApiKeyState> = new Map([
  ['live', 'live'],
  ['expired', 'expired'],
  ['revoked', 'revoked'],
]);

function storedState(value: unknown): ApiKeyState {
  const state = STATES.get(value);
  if (state === undefined) throw new Error('stored key state is unknown');
  return state;
}

// The verifier's own test of a live key, so the list cannot show as live a key it refuses.
const IS_LIVE = sql<SqlBool>`k.revoked_at is null and (k.expires_at is null or k.expires_at > now())`;

const STATE = sql<string>`case
  when k.revoked_at is not null then 'revoked'
  when ${IS_LIVE} then 'live'
  else 'expired' end`;

const hasProduct = (products: readonly Product[]) =>
  sql<SqlBool>`exists (select from unnest(k.scopes) s where split_part(s, ':', 1) = any(${[...products]}::text[]))`;

const LAST_USED: Readonly<Record<ApiKeyLastUsed, RawBuilder<SqlBool> | null>> = {
  any: null,
  '7d': sql<SqlBool>`k.last_used_at >= now() - interval '7 days'`,
  '30d': sql<SqlBool>`k.last_used_at >= now() - interval '30 days'`,
  never: sql<SqlBool>`k.last_used_at is null`,
};

function creatorFilter(q: ListQuery): RawBuilder<SqlBool> | null {
  const named = sql<SqlBool>`k.created_by = any(${[...q.creators]}::uuid[])`;
  const former = sql<SqlBool>`k.created_by is null`;
  if (q.creators.length === 0) return q.former ? former : null;
  return q.former ? sql<SqlBool>`(${named} or ${former})` : named;
}

// The page and its match count share this, so they can never disagree. Search is a plain
// substring test: strpos has no pattern characters to escape.
function matching(q: ListQuery): RawBuilder<SqlBool> {
  const clauses = [
    q.search === null ? null : sql<SqlBool>`strpos(lower(k.name), lower(${q.search})) > 0`,
    q.products === null ? null : hasProduct(q.products),
    creatorFilter(q),
    LAST_USED[q.lastUsed],
  ].filter((clause) => clause !== null);
  return clauses.length === 0 ? sql<SqlBool>`true` : sql<SqlBool>`${sql.join(clauses, sql` and `)}`;
}

type Tx = Transaction<OrganizationSchema>;

interface StoredKey {
  readonly id: string;
  readonly name: string;
  readonly display_suffix: string;
  readonly scopes: readonly string[];
  readonly project_scope: string;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly expires_at: Date | null;
  readonly last_used_at: Date | null;
  readonly revoked_at: Date | null;
}

function summaryOf(
  organizationId: OrganizationId,
  row: StoredKey,
  projectIds: readonly ProjectId[],
): ApiKeySummary {
  return Object.freeze({
    keyId: idOf('key', row.id),
    organizationId,
    name: row.name,
    displaySuffix: row.display_suffix,
    scopes: Object.freeze([...row.scopes] as Scope[]),
    projectScope: storedProjectScope(row.project_scope),
    projectIds: Object.freeze([...projectIds]),
    createdBy: row.created_by === null ? null : idOf('mem', row.created_by),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  });
}

// The role as stored now, not as the guard saw it. For share, so a demotion or removal in
// flight waits for this work and then sees what it did.
async function storedManager(
  tx: Tx,
  userId: UserId,
  needs: readonly Permission[],
): Promise<string> {
  const member = await tx
    .selectFrom('memberships')
    .select(['id', 'role', 'default_project_role'])
    .where('user_id', '=', userId)
    .forShare()
    .executeTakeFirst();
  if (member === undefined) throw FORBIDDEN();
  if (!holdsAll(storedPermissions(member.role, member.default_project_role), needs)) {
    throw FORBIDDEN();
  }
  return member.id;
}

async function listedProjects(
  tx: Tx,
  key: Pick<StoredKey, 'id' | 'project_scope'>,
): Promise<ProjectId[]> {
  if (key.project_scope !== 'listed') return [];
  const rows = await tx
    .selectFrom('api_key_projects')
    .select('target_project_id')
    .where('api_key_id', '=', key.id)
    .orderBy('target_project_id')
    .execute();
  return rows.map((r) => idOf('prj', r.target_project_id));
}

const listColumns = KEY_COLUMNS.map((column) => `k.${column}` as const);

async function readPage(tx: Tx, organizationId: OrganizationId, q: ListQuery) {
  let page = tx
    .selectFrom('api_keys as k')
    .leftJoin('memberships as m', (join) =>
      join.onRef('m.organization_id', '=', 'k.organization_id').onRef('m.id', '=', 'k.created_by'),
    )
    .leftJoin('users as u', 'u.id', 'm.user_id')
    .select(listColumns)
    .select(['u.display_name', 'u.email', STATE.as('state')])
    .where('k.organization_id', '=', organizationId)
    .where(matching(q));
  if (q.after !== null) page = page.where('k.id', '<', q.after);
  // One more than asked for says whether another page exists, with no second count.
  return page
    .orderBy('k.id', 'desc')
    .limit(q.limit + 1)
    .execute();
}

async function readPageProjects(
  tx: Tx,
  organizationId: OrganizationId,
  keys: readonly Pick<StoredKey, 'id' | 'project_scope'>[],
): Promise<ReadonlyMap<string, readonly ProjectId[]>> {
  const out = new Map<string, ProjectId[]>();
  const listed = keys.filter((k) => k.project_scope === 'listed').map((k) => k.id);
  if (listed.length === 0) return out;
  const rows = await tx
    .selectFrom('api_key_projects')
    .select(['api_key_id', 'target_project_id'])
    .where('organization_id', '=', organizationId)
    .where('api_key_id', 'in', listed)
    .orderBy('target_project_id')
    .execute();
  for (const row of rows) {
    const projects = out.get(row.api_key_id) ?? [];
    projects.push(idOf('prj', row.target_project_id));
    out.set(row.api_key_id, projects);
  }
  return out;
}

// One scan of the organization's keys for every count on the page.
function readCounts(tx: Tx, organizationId: OrganizationId, q: ListQuery) {
  return tx
    .selectFrom('api_keys as k')
    .select([
      sql<number>`count(*)::int`.as('total'),
      sql<number>`(count(*) filter (where ${matching(q)}))::int`.as('matched'),
      sql<number>`(count(*) filter (where ${IS_LIVE}))::int`.as('live'),
      sql<number>`(count(*) filter (where k.created_by is null))::int`.as('former_keys'),
      ...PRODUCTS.map((product) =>
        sql<number>`(count(*) filter (where ${hasProduct([product])}))::int`.as(product),
      ),
    ])
    .where('k.organization_id', '=', organizationId)
    .executeTakeFirstOrThrow();
}

function readCreators(tx: Tx, organizationId: OrganizationId) {
  return tx
    .selectFrom('api_keys as k')
    .innerJoin('memberships as m', (join) =>
      join.onRef('m.organization_id', '=', 'k.organization_id').onRef('m.id', '=', 'k.created_by'),
    )
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['m.id', 'u.display_name', 'u.email', sql<number>`count(*)::int`.as('keys')])
    .where('k.organization_id', '=', organizationId)
    .groupBy(['m.id', 'u.display_name', 'u.email'])
    .orderBy('m.id')
    .execute();
}

async function ownerIds(tx: Tx): Promise<string[]> {
  const rows = await tx
    .selectFrom('memberships')
    .select('user_id')
    .where('role', '=', 'owner')
    .execute();
  return rows.map((o) => o.user_id);
}

interface Made {
  readonly membershipId: string;
  readonly createdAt: Date;
  readonly owners: readonly string[];
}

interface Revoked {
  readonly key: StoredKey;
  readonly revokedAt: Date;
  readonly projectIds: readonly ProjectId[];
  readonly membershipId: string;
  // Null when an earlier call revoked it: that call owns the notice.
  readonly owners: readonly string[] | null;
}

export function createApiKeys(deps: ApiKeysDeps): ApiKeys {
  const { db, authDb } = deps;
  let store: ApiKeyStore;
  if (deps.store !== undefined) {
    store = deps.store;
  } else if (db !== undefined && authDb !== undefined) {
    store = {
      user: (userId, work) => withUser(db, { userId }, work),
      auth: (work) => withAuth(authDb, work),
      organization: (organizationId, work) => withOrganization(db, { organizationId }, work),
      organizationAs: (organizationId, actorUserId, work) =>
        withOrganization(db, { organizationId, actorUserId }, work),
    };
  } else {
    throw new AuthError('AUTH_CONFIG_INVALID');
  }
  const random = deps.random ?? ((n: number) => randomBytes(n));
  const nextKeyId = deps.newKeyId ?? (() => newId('key'));

  // Never throws, and every miss is one line with no address.
  function noticeSender(
    owners: readonly string[],
    notice: AuthSecurityNotice,
    ids: Parameters<typeof idFields>[0],
  ): () => Promise<void> {
    const missed = () => {
      quietWarn(deps.logger, 'auth.api_key_notice_failed', idFields(ids));
    };
    return async () => {
      try {
        if (owners.length === 0) return;
        // Addresses are read through the sign in role, the one that holds them.
        const rows = await store.auth((tx) =>
          tx.selectFrom('users').select('email').where('id', 'in', owners).execute(),
        );
        await noticeEach(
          deps.mailer,
          rows.map((row) => row.email),
          notice,
          missed,
        );
      } catch {
        missed();
      }
    };
  }

  return Object.freeze({
    async createApiKey(a, raw) {
      const input = parse(raw, deps.scopes);
      if (input === null) return fail(INVALID());
      // The guard's context first, before any statement: a member never reaches the database.
      if (!holdsAll(a.permissions, input.needs)) return fail(FORBIDDEN());
      const recent = await checkRecentAuth(store, a);
      if (!recent.ok) return recent;

      const organizationId = a.organizationId;
      const keyId = nextKeyId();
      const secret = Buffer.from(random(SECRET_BYTES));
      const displaySuffix = encodeSecret(secret).slice(-4);
      const hash = requestHash(input);
      const ids = { organizationId: ['org', organizationId], keyId: ['key', keyId] } as const;

      let made: Made;
      try {
        made = await store.organizationAs(organizationId, a.userId, async (tx) => {
          const membershipId = await storedManager(tx, a.userId, input.needs);
          if (input.projectScope === 'listed') {
            const found = await tx
              .selectFrom('projects')
              .select('id')
              .where('id', 'in', input.projectIds)
              .execute();
            if (found.length !== input.projectIds.length) throw INVALID();
          }
          const inserted = await tx
            .insertInto('api_keys')
            .values({
              id: keyId,
              organization_id: organizationId,
              name: input.name,
              secret_hash: sha256(secret),
              display_suffix: displaySuffix,
              scopes: [...input.scopes],
              project_scope: input.projectScope,
              created_by: membershipId,
              expires_at: input.expiresAt,
              idempotency_key: input.idempotencyKey,
              request_hash: hash,
            })
            .onConflict((oc) => oc.columns(['organization_id', 'idempotency_key']).doNothing())
            .returning('created_at')
            .executeTakeFirst();
          if (inserted === undefined) {
            const existing = await tx
              .selectFrom('api_keys')
              .select([...KEY_COLUMNS, 'request_hash'])
              .where('idempotency_key', '=', input.idempotencyKey)
              .executeTakeFirst();
            // A conflict with no row to show is a fault, not a person to answer.
            if (existing === undefined) throw new AuthError('AUTH_UNAVAILABLE');
            if (!constantTimeEqual(existing.request_hash, hash)) throw INVALID();
            throw new ApiKeyReplayError(
              summaryOf(organizationId, existing, await listedProjects(tx, existing)),
            );
          }
          if (input.projectScope === 'listed') {
            await tx
              .insertInto('api_key_projects')
              .values(
                input.projectIds.map((target) => ({
                  organization_id: organizationId,
                  api_key_id: keyId,
                  target_project_id: target,
                })),
              )
              .execute();
          }
          return {
            membershipId,
            createdAt: inserted.created_at,
            owners: await ownerIds(tx),
          };
        });
      } catch (error) {
        if (!(error instanceof AuthError)) {
          quietWarn(deps.logger, 'auth.api_key_create_failed', idFields(ids));
        }
        return fail(error);
      }

      const key = summaryOf(
        organizationId,
        {
          id: keyId,
          name: input.name,
          display_suffix: displaySuffix,
          scopes: input.scopes,
          project_scope: input.projectScope,
          created_by: made.membershipId,
          created_at: made.createdAt,
          expires_at: input.expiresAt,
          last_used_at: null,
          revoked_at: null,
        },
        input.projectIds,
      );
      quietInfo(deps.logger, 'auth.api_key_created', {
        ...idFields({
          ...ids,
          membershipId: ['mem', made.membershipId],
          userId: ['usr', a.userId],
        }),
        scopes: input.scopes.length,
        projectScope: input.projectScope,
      });

      const notice: AuthSecurityNotice = {
        kind: 'api_key_created',
        organizationId,
        keyId,
        keyName: input.name,
        displaySuffix,
        at: made.createdAt,
      };
      return ok({
        key,
        secret: formatApiKey({ organizationId, keyId, secret }),
        send: noticeSender(made.owners, notice, ids),
      });
    },

    async revokeApiKey(a, rawId) {
      const keyId = asId('key', rawId);
      if (keyId === null) return fail(INVALID());
      // The guard's context first, before any statement: a member never reaches the database.
      if (!holdsAll(a.permissions, [])) return fail(FORBIDDEN());
      const recent = await checkRecentAuth(store, a);
      if (!recent.ok) return recent;

      const organizationId = a.organizationId;
      const ids = { organizationId: ['org', organizationId], keyId: ['key', keyId] } as const;

      let done: Revoked;
      try {
        done = await store.organizationAs(organizationId, a.userId, async (tx) => {
          const membershipId = await storedManager(tx, a.userId, []);
          // Live keys only, so of two racing revokes the second waits, matches nothing and
          // reads the first one's time.
          const written = await tx
            .updateTable('api_keys')
            .set({ revoked_at: sql<Date>`now()` })
            .where('organization_id', '=', organizationId)
            .where('id', '=', keyId)
            .where('revoked_at', 'is', null)
            .returning(KEY_COLUMNS)
            .executeTakeFirst();
          const key =
            written ??
            (await tx
              .selectFrom('api_keys')
              .select(KEY_COLUMNS)
              .where('organization_id', '=', organizationId)
              .where('id', '=', keyId)
              .executeTakeFirst());
          // A foreign key is hidden by row level security, so it reads as unknown.
          if (key?.revoked_at == null) throw new AuthError('AUTH_NOT_FOUND');
          return {
            key,
            revokedAt: key.revoked_at,
            projectIds: await listedProjects(tx, key),
            membershipId,
            owners: written === undefined ? null : await ownerIds(tx),
          };
        });
      } catch (error) {
        if (!(error instanceof AuthError)) {
          quietWarn(deps.logger, 'auth.api_key_revoke_failed', idFields(ids));
        }
        return fail(error);
      }

      const key = summaryOf(organizationId, done.key, done.projectIds);
      if (done.owners === null) {
        return ok({ key, alreadyRevoked: true, send: () => Promise.resolve() });
      }
      quietInfo(
        deps.logger,
        'auth.api_key_revoked',
        idFields({
          ...ids,
          membershipId: ['mem', done.membershipId],
          userId: ['usr', a.userId],
        }),
      );
      const notice: AuthSecurityNotice = {
        kind: 'api_key_revoked',
        organizationId,
        keyId,
        keyName: storedKeyName(key.name),
        displaySuffix: key.displaySuffix,
        at: done.revokedAt,
      };
      return ok({ key, alreadyRevoked: false, send: noticeSender(done.owners, notice, ids) });
    },

    async listApiKeys(a, raw) {
      const q = parseList(raw);
      if (q === null) return fail(INVALID());
      if (!a.permissions.includes(READ)) return fail(FORBIDDEN());

      const organizationId = a.organizationId;
      try {
        const page = await store.organization(organizationId, async (tx) => {
          const rows = await readPage(tx, organizationId, q);
          const shown = rows.slice(0, q.limit);
          return {
            shown,
            more: rows.length > q.limit,
            projects: await readPageProjects(tx, organizationId, shown),
            counts: await readCounts(tx, organizationId, q),
            creators: await readCreators(tx, organizationId),
          };
        });
        const items = page.shown.map((row) =>
          Object.freeze({
            ...summaryOf(organizationId, row, page.projects.get(row.id) ?? []),
            state: storedState(row.state),
            creatorName:
              row.created_by === null || row.email === null
                ? null
                : memberName(row.display_name, row.email),
          }),
        );
        const { counts } = page;
        return ok(
          Object.freeze({
            items: Object.freeze(items),
            nextCursor: page.more ? encodeCursor(page.shown[q.limit - 1]?.id ?? '') : null,
            matched: counts.matched,
            total: counts.total,
            live: counts.live,
            creators: Object.freeze(
              page.creators.map((c) =>
                Object.freeze({
                  membershipId: idOf('mem', c.id),
                  name: memberName(c.display_name, c.email),
                  keys: c.keys,
                }),
              ),
            ),
            formerKeys: counts.former_keys,
            products: Object.freeze(
              Object.fromEntries(PRODUCTS.map((product) => [product, counts[product]])) as Record<
                Product,
                number
              >,
            ),
          }),
        );
      } catch (error) {
        if (!(error instanceof AuthError)) {
          quietWarn(
            deps.logger,
            'auth.api_key_list_failed',
            idFields({ organizationId: ['org', organizationId], userId: ['usr', a.userId] }),
          );
        }
        return fail(error);
      }
    },
  } satisfies ApiKeys);
}
