import type { Result } from '@drefyn/address';
import {
  newId,
  withAuth,
  withOrganization,
  withUser,
  type AuthDatabase,
  type Database,
} from '@drefyn/db';
import { idOf, type IdOf, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { storedPermissions, type AccessContext } from './access.ts';
import type { AuthNoticeMailer, AuthSecurityNotice } from './email-change.ts';
import { AuthError } from './errors.ts';
import { constantTimeEqual, lengthPrefixed, sha256 } from './keys.ts';
import { parseOrganizationName } from './organization-rules.ts';
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
  // Null once the creator's membership is gone.
  readonly createdBy: IdOf<'mem'> | null;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastUsedAt: Date | null;
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

// A repeat of a request already made: the key it made, without the secret, which was shown
// once and is gone.
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
  });
}

interface Made {
  readonly membershipId: string;
  readonly createdAt: Date;
  readonly owners: readonly string[];
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
          // The role as stored now: one demoted since the guard ran cannot mint a key. For
          // share, so a demotion or removal in flight waits for this key and then revokes it.
          const member = await tx
            .selectFrom('memberships')
            .select(['id', 'role', 'default_project_role'])
            .where('user_id', '=', a.userId)
            .forShare()
            .executeTakeFirst();
          if (member === undefined) throw FORBIDDEN();
          if (!holdsAll(storedPermissions(member.role, member.default_project_role), input.needs)) {
            throw FORBIDDEN();
          }
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
              created_by: member.id,
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
              .select([
                'id',
                'name',
                'display_suffix',
                'scopes',
                'project_scope',
                'created_by',
                'created_at',
                'expires_at',
                'last_used_at',
                'request_hash',
              ])
              .where('idempotency_key', '=', input.idempotencyKey)
              .executeTakeFirst();
            // A conflict with no row to show is a fault, not a person to answer.
            if (existing === undefined) throw new AuthError('AUTH_UNAVAILABLE');
            if (!constantTimeEqual(existing.request_hash, hash)) throw INVALID();
            const listed =
              existing.project_scope === 'listed'
                ? await tx
                    .selectFrom('api_key_projects')
                    .select('target_project_id')
                    .where('api_key_id', '=', existing.id)
                    .orderBy('target_project_id')
                    .execute()
                : [];
            throw new ApiKeyReplayError(
              summaryOf(
                organizationId,
                existing,
                listed.map((r) => idOf('prj', r.target_project_id)),
              ),
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
          const owners = await tx
            .selectFrom('memberships')
            .select('user_id')
            .where('role', '=', 'owner')
            .execute();
          return {
            membershipId: member.id,
            createdAt: inserted.created_at,
            owners: owners.map((o) => o.user_id),
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
      const send = async () => {
        try {
          if (made.owners.length === 0) return;
          // Addresses are read through the sign in role, the one that holds them.
          const rows = await store.auth((tx) =>
            tx.selectFrom('users').select('email').where('id', 'in', made.owners).execute(),
          );
          for (const row of rows) await deps.mailer.sendSecurityNotice(row.email, notice);
        } catch {
          quietWarn(deps.logger, 'auth.api_key_notice_failed', idFields(ids));
        }
      };
      return ok({ key, secret: formatApiKey({ organizationId, keyId, secret }), send });
    },
  } satisfies ApiKeys);
}
