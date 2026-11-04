import type { Result } from '@drefyn/address';
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
import { sql, type Transaction } from 'kysely';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { storedPermissions, type AccessContext } from './access.ts';
import type { AuthNoticeMailer, AuthSecurityNotice } from './email-change.ts';
import { AuthError } from './errors.ts';
import { constantTimeEqual, lengthPrefixed, sha256 } from './keys.ts';
import { parseOrganizationName } from './organization-rules.ts';
import { noticeEach } from './notices.ts';
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
}

const MAX_KEY_SCOPES = 32;
const MAX_PROJECTS = 100;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;
const MANAGE: Permission = 'org.manage_api_keys';

const INPUT = z.strictObject({
  name: z.unknown(),
  scopes: z.array(z.string()).min(1).max(MAX_KEY_SCOPES),
  projectScope: z.enum(['all', 'listed']),
  projectIds: z.array(z.string()).max(MAX_PROJECTS).optional(),
  expiresAt: z.date().optional(),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
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
        keyName: key.name,
        displaySuffix: key.displaySuffix,
        at: done.revokedAt,
      };
      return ok({ key, alreadyRevoked: false, send: noticeSender(done.owners, notice, ids) });
    },
  } satisfies ApiKeys);
}
