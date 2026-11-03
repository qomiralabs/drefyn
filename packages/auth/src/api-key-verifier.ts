import type { Result } from '@drefyn/address';
import { withOrganization, type Database, type OrganizationSchema } from '@drefyn/db';
import { idOf, type IdOf, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { storedProjectScope } from './api-keys.ts';
import { rateKeyForIp } from './client-ip.ts';
import { parseApiAuthConfig, type Env } from './config.ts';
import { AuthError } from './errors.ts';
import { constantTimeEqual, sha256 } from './keys.ts';
import {
  createApiKeyFailureLimiter,
  type ApiKeyFailureLimiter,
  type AuthLogger,
} from './rate-limiter.ts';
import { isScopeShape, type Scope } from './scopes.ts';
import { fail, idFields, ok, quietWarn } from './session-support.ts';
import { parseBearer, type ApiKeyParts } from './tokens.ts';

// An organization actor, never a user and never a seat.
export interface ApiKeyActor {
  readonly kind: 'api_key';
  readonly keyId: IdOf<'key'>;
  readonly organizationId: OrganizationId;
  readonly scopes: readonly Scope[];
  // 'all' only ever comes from the stored project scope, never from missing rows.
  readonly projectIds: readonly ProjectId[] | 'all';
}

export interface ApiKeyVerifierStore {
  organization<T>(
    organizationId: OrganizationId,
    work: (tx: Transaction<OrganizationSchema>) => Promise<T>,
  ): Promise<T>;
}

export interface ApiKeyVerifierDeps {
  // drefyn_app. The API service holds no auth role and no auth secret.
  readonly db?: Database;
  readonly store?: ApiKeyVerifierStore;
  readonly limiter?: ApiKeyFailureLimiter;
  readonly logger: AuthLogger;
}

export interface ApiRequest {
  readonly authorization: string | undefined;
  readonly url: string | URL;
  // Already resolved through the trusted hops.
  readonly ip: string;
}

export interface ApiKeyVerifier {
  verifyApiKey(
    authorization: string | undefined,
    ip: string,
  ): Promise<Result<ApiKeyActor, AuthError>>;
  // The whole request: a key in the query string is refused before the header is read, since
  // query strings end up in access logs and browser history.
  verifyApiRequest(request: ApiRequest): Promise<Result<ApiKeyActor, AuthError>>;
}

// Compared against on a miss, so a missing row costs the same compare as a wrong secret.
const DUMMY_HASH = Buffer.alloc(32);
// Any drf_ credential format, whatever its case once decoded.
const CARRIES_KEY = /drf_[a-z]{2}_/i;

// Thrown inside the transaction to roll it back before anything else is sent.
class Refused extends Error {}
const REFUSED = new Refused('refused');

function storedScopes(values: readonly string[]): readonly Scope[] {
  if (!values.every(isScopeShape)) throw new Error('stored scope is unknown');
  return Object.freeze([...values]);
}

// The first statement: the key row alone, by id, with its project scope. The compare runs here
// in process; any failure throws before a second statement is sent.
async function prove(
  tx: Transaction<OrganizationSchema>,
  parts: ApiKeyParts,
): Promise<ApiKeyActor> {
  const row = await tx
    .selectFrom('api_keys')
    .select([
      'id',
      'secret_hash',
      'scopes',
      'project_scope',
      // Database time only, so a skewed app clock cannot stretch a key.
      sql<boolean>`expires_at is null or expires_at > now()`.as('live'),
      sql<boolean>`last_used_at is null or last_used_at < now() - interval '1 hour'`.as('use_due'),
    ])
    .where('id', '=', parts.keyId)
    .where('organization_id', '=', parts.organizationId)
    .executeTakeFirst();
  const matched = constantTimeEqual(sha256(parts.secret), row?.secret_hash ?? DUMMY_HASH);
  if (row === undefined || !matched || !row.live) throw REFUSED;

  const scopes = storedScopes(row.scopes);
  let projectIds: readonly ProjectId[] | 'all' = 'all';
  if (storedProjectScope(row.project_scope) === 'listed') {
    const rows = await tx
      .selectFrom('api_key_projects')
      .select('target_project_id')
      .where('api_key_id', '=', row.id)
      .orderBy('target_project_id')
      .execute();
    projectIds = Object.freeze(rows.map((r) => idOf('prj', r.target_project_id)));
  }
  // At most once an hour, so steady traffic reads and never writes.
  if (row.use_due) {
    await tx
      .updateTable('api_keys')
      .set({ last_used_at: sql<Date>`now()` })
      .where('id', '=', row.id)
      .where((eb) =>
        eb.or([
          eb('last_used_at', 'is', null),
          eb('last_used_at', '<', sql<Date>`now() - interval '1 hour'`),
        ]),
      )
      .execute();
  }
  return Object.freeze({
    kind: 'api_key',
    keyId: parts.keyId,
    organizationId: parts.organizationId,
    scopes,
    projectIds,
  });
}

// Built at API service startup. The env is parsed here, so the service cannot build one while
// it holds the auth database URL or the auth secret: it refuses to start instead.
export function createApiKeyVerifier(env: Env, deps: ApiKeyVerifierDeps): ApiKeyVerifier {
  const config = parseApiAuthConfig(env);
  const { db } = deps;
  const givenStore: ApiKeyVerifierStore | undefined =
    deps.store ??
    (db === undefined
      ? undefined
      : { organization: (organizationId, work) => withOrganization(db, { organizationId }, work) });
  const givenLimiter =
    deps.limiter ?? (db === undefined ? undefined : createApiKeyFailureLimiter({ db, config }));
  if (givenStore === undefined || givenLimiter === undefined) {
    throw new AuthError('AUTH_CONFIG_INVALID');
  }
  const store = givenStore;
  const limiter = givenLimiter;

  // Every failed check is counted in the limiter's own transaction, after the key's rolled
  // back. Nothing is logged: a flood of bad keys must not become a flood of log lines.
  async function refuse(ip: string): Promise<Result<ApiKeyActor, AuthError>> {
    try {
      await limiter.reserve(rateKeyForIp(ip));
    } catch (error) {
      return fail(error);
    }
    return fail(new AuthError('AUTH_API_KEY_INVALID'));
  }

  async function verifyApiKey(
    authorization: string | undefined,
    ip: string,
  ): Promise<Result<ApiKeyActor, AuthError>> {
    const parts = parseBearer(authorization);
    if (parts === null) return refuse(ip);
    try {
      return ok(await store.organization(parts.organizationId, (tx) => prove(tx, parts)));
    } catch (error) {
      if (error === REFUSED) return refuse(ip);
      // The ids came from the request and are not proved, so they are logged as claimed.
      quietWarn(
        deps.logger,
        'auth.api_key_verify_failed',
        idFields({
          claimedOrganizationId: ['org', parts.organizationId],
          keyId: ['key', parts.keyId],
        }),
      );
      return fail(error);
    }
  }

  return Object.freeze({
    verifyApiKey,
    async verifyApiRequest(request: ApiRequest) {
      let search: URLSearchParams;
      try {
        search = (typeof request.url === 'string' ? new URL(request.url) : request.url)
          .searchParams;
      } catch {
        return refuse(request.ip);
      }
      for (const [name, value] of search) {
        if (CARRIES_KEY.test(name) || CARRIES_KEY.test(value)) return refuse(request.ip);
      }
      return verifyApiKey(request.authorization, request.ip);
    },
  } satisfies ApiKeyVerifier);
}

// A request is in reach when the key holds the scope and, for project work, the project.
export function checkApiKeyScope(
  actor: ApiKeyActor,
  scope: Scope,
  projectId?: ProjectId,
): Result<void, AuthError> {
  const inReach =
    projectId === undefined || actor.projectIds === 'all' || actor.projectIds.includes(projectId);
  return actor.scopes.includes(scope) && inReach
    ? ok(undefined)
    : fail(new AuthError('AUTH_API_KEY_SCOPE'));
}

export interface ApiErrorResponse {
  readonly status: 401 | 403 | 429 | 503;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const BASE_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' } as const;

const body = (code: string) => JSON.stringify({ error: { code } });

// The public contract for a refused key. Only additive changes: clients match on these codes.
export function apiKeyErrorResponse(error: AuthError): ApiErrorResponse {
  switch (error.code) {
    case 'AUTH_API_KEY_SCOPE':
      return { status: 403, headers: { ...BASE_HEADERS }, body: body('auth.api_key_scope') };
    case 'AUTH_RATE_LIMITED':
      return {
        status: 429,
        headers: {
          ...BASE_HEADERS,
          'retry-after': String(Math.max(1, Math.ceil(error.retryAfterSeconds ?? 1))),
        },
        body: body('auth.rate_limited'),
      };
    case 'AUTH_UNAVAILABLE':
      return { status: 503, headers: { ...BASE_HEADERS }, body: body('auth.unavailable') };
    default:
      // Every other refusal reads the same, so the answer says nothing about why.
      return { status: 401, headers: { ...BASE_HEADERS }, body: body('auth.api_key_invalid') };
  }
}
