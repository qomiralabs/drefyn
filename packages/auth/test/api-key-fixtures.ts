import { createHash } from 'node:crypto';
import { idOf, type IdOf, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import { grantAccess, type AccessContext } from '../src/access.ts';
import {
  createApiKeyVerifier,
  createScopeRegistry,
  type ApiKeyFailureLimiter,
  encodeSecret,
  formatApiKey,
  type ScopeRegistry,
} from '../src/index.ts';
import type { OrgRole } from '../src/permissions.ts';
import { scriptedStore, type Responder, type Statement } from './scripted-store.ts';
import { AUTHENTICATED_AT, SESSION, USER, capturingLogger } from './session-fixtures.ts';
import { base64url } from './support.ts';

// Fixed ids, built rather than written out so no line reads like a credential to a scanner.
const fixed = (n: number) => `01890a5d-ac96-774b-bcce-b302099a80${String(n)}`;

export const ORG: OrganizationId = idOf('org', fixed(70));
export const OTHER_ORG: OrganizationId = idOf('org', fixed(79));
export const MEMBERSHIP: IdOf<'mem'> = idOf('mem', fixed(71));
export const OWNER_USER = fixed(72);
export const KEY: IdOf<'key'> = idOf('key', fixed(73));
export const OTHER_KEY: IdOf<'key'> = idOf('key', fixed(74));
export const PROJECT_A: ProjectId = idOf('prj', fixed(75));
export const PROJECT_B: ProjectId = idOf('prj', fixed(76));
export const CREATED_AT = new Date('2026-11-03T09:00:00.000Z');
export const REVOKED_AT = new Date('2026-11-04T09:00:00.000Z');
export const FIRST_REVOKED_AT = new Date('2026-11-04T08:00:00.000Z');
export const KEY_SECRET = Buffer.alloc(32, 7);

export const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();

export const SCOPES: ScopeRegistry = createScopeRegistry([
  { scope: 'docs:read', permission: 'docs.read' },
  { scope: 'docs:publish', permission: 'docs.read' },
  { scope: 'status:read', permission: 'status.read' },
  { scope: 'studio:read', permission: 'studio.read' },
  { scope: 'docs:projects.create', permission: 'project.create' },
]);

export function access(role: OrgRole = 'owner', defaultProjectRole: string | null = null) {
  return grantAccess({
    organizationId: ORG,
    userId: USER,
    sessionId: SESSION,
    role,
    defaultProjectRole,
    tier: 'growth',
    authenticatedAt: AUTHENTICATED_AT,
  }) satisfies AccessContext;
}

export function keyFor(
  org: OrganizationId = ORG,
  key: IdOf<'key'> = KEY,
  secret: Uint8Array = KEY_SECRET,
): string {
  return formatApiKey({ organizationId: org, keyId: key, secret });
}

export const bearer = (value: string = keyFor()) => `Bearer ${value}`;

export const suffixOf = (secret: Uint8Array) => encodeSecret(secret).slice(-4);

const select = (s: Statement, table: string) =>
  /^select\b/i.test(s.sql) && s.sql.includes(`from "${table}"`);

export const isKeyProof = (s: Statement) =>
  select(s, 'api_keys') && !s.sql.includes('idempotency_key" =');
export const isKeyProjects = (s: Statement) => select(s, 'api_key_projects');
export const isUseWrite = (s: Statement) => /^update "api_keys" set "last_used_at"/i.test(s.sql);
export const isRevokeWrite = (s: Statement) => /^update "api_keys" set "revoked_at"/i.test(s.sql);
export const isRecentRead = (s: Statement) => select(s, 'sessions');
export const isMemberRead = (s: Statement) =>
  select(s, 'memberships') && s.sql.includes('"user_id" =');
export const isOwnerRead = (s: Statement) => select(s, 'memberships') && s.sql.includes('"role" =');
export const isProjectRead = (s: Statement) => select(s, 'projects');
export const isKeyInsert = (s: Statement) => /^insert into "api_keys"/i.test(s.sql);
export const isProjectInsert = (s: Statement) => /^insert into "api_key_projects"/i.test(s.sql);
export const isReplayRead = (s: Statement) =>
  select(s, 'api_keys') && s.sql.includes('"idempotency_key" =');
export const isEmailsRead = (s: Statement) => select(s, 'users');

export interface KeyRowShape {
  readonly id?: string;
  readonly secret?: Uint8Array;
  readonly live?: boolean;
  readonly useDue?: boolean;
  readonly projectScope?: string;
  readonly scopes?: readonly string[];
}

// The proof row the first statement of verifyApiKey returns, as the database would.
export function keyRow(shape: KeyRowShape = {}): Record<string, unknown> {
  return {
    id: shape.id ?? KEY,
    secret_hash: sha(shape.secret ?? KEY_SECRET),
    scopes: [...(shape.scopes ?? ['docs:read'])],
    project_scope: shape.projectScope ?? 'all',
    live: shape.live ?? true,
    use_due: shape.useDue ?? false,
  };
}

// Answers the proof with the row whose id is among the parameters, and the project read with
// the given project ids.
export function verifyResponder(
  rows: readonly Record<string, unknown>[],
  projects: readonly string[] = [],
): Responder {
  return (s) => {
    // Rows belong to ORG; RLS hides them under any other organization.
    if (isKeyProof(s)) {
      return s.parameters.includes(ORG)
        ? rows.filter((row) => s.parameters.includes(row['id']))
        : [];
    }
    if (isKeyProjects(s)) return projects.map((id) => ({ target_project_id: id }));
    if (isUseWrite(s)) return [];
    return [];
  };
}

export interface CreateShape {
  readonly recent?: boolean;
  readonly sessionFound?: boolean;
  readonly role?: string | null;
  readonly projects?: readonly string[];
  readonly inserted?: boolean;
  readonly replay?: Record<string, unknown> | null;
  readonly replayProjects?: readonly string[];
  readonly owners?: readonly string[];
  readonly emails?: readonly string[];
}

// Every statement createApiKey sends, answered as the database would when nothing is in the
// way unless the shape says otherwise.
export function createResponder(shape: CreateShape = {}): Responder {
  return (s) => {
    if (isRecentRead(s)) {
      return shape.sessionFound === false ? [] : [{ recent: shape.recent ?? true }];
    }
    if (isMemberRead(s)) {
      return shape.role === null
        ? []
        : [{ id: MEMBERSHIP, role: shape.role ?? 'owner', default_project_role: null }];
    }
    if (isProjectRead(s)) {
      const known = shape.projects ?? [PROJECT_A, PROJECT_B];
      return known.filter((id) => s.parameters.includes(id)).map((id) => ({ id }));
    }
    if (isKeyInsert(s)) return shape.inserted === false ? [] : [{ created_at: CREATED_AT }];
    if (isReplayRead(s))
      return shape.replay === null || shape.replay === undefined ? [] : [shape.replay];
    if (isKeyProjects(s)) {
      return (shape.replayProjects ?? []).map((id) => ({ target_project_id: id }));
    }
    if (isOwnerRead(s)) return (shape.owners ?? [OWNER_USER]).map((id) => ({ user_id: id }));
    if (isEmailsRead(s)) {
      return (shape.emails ?? ['owner@example.com']).map((email) => ({ email }));
    }
    return [];
  };
}

export type RevokeState = 'live' | 'revoked' | 'absent';

export interface RevokeShape extends CreateShape {
  readonly state?: RevokeState;
  readonly projectScope?: 'all' | 'listed';
}

export function storedKey(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: KEY,
    name: 'Deploy from CI',
    display_suffix: 'x7qa',
    scopes: ['docs:read'],
    project_scope: 'all',
    created_by: MEMBERSHIP,
    created_at: CREATED_AT,
    expires_at: null,
    last_used_at: null,
    revoked_at: null,
    ...over,
  };
}

// Every statement revokeApiKey sends, answered as the database would for a key in that state.
export function revokeResponder(shape: RevokeShape = {}): Responder {
  const state = shape.state ?? 'live';
  const row = { project_scope: shape.projectScope ?? 'all' };
  const members = createResponder(shape);
  return (s) => {
    if (isRevokeWrite(s)) {
      return state === 'live' ? [storedKey({ ...row, revoked_at: REVOKED_AT })] : [];
    }
    if (isKeyProof(s)) {
      return state === 'revoked' ? [storedKey({ ...row, revoked_at: FIRST_REVOKED_AT })] : [];
    }
    return members(s);
  };
}

export interface ListShape {
  readonly keys?: readonly Record<string, unknown>[];
  readonly projects?: readonly { api_key_id: string; target_project_id: string }[];
  readonly counts?: Record<string, unknown>;
  readonly creators?: readonly Record<string, unknown>[];
}

export const isPageRead = (s: Statement) =>
  /^select\b/i.test(s.sql) &&
  s.sql.includes('"api_keys" as "k"') &&
  s.sql.includes('"m"."id" = "k"."created_by"') &&
  s.sql.includes(' limit ');
export const isCountsRead = (s: Statement) =>
  /^select\b/i.test(s.sql) && s.sql.includes('as "total"');
export const isCreatorsRead = (s: Statement) =>
  /^select\b/i.test(s.sql) && s.sql.includes('group by');

// Every statement listApiKeys sends, answered as the database would. The page row carries the
// joined person and the state, as the statement selects them.
export function listResponder(shape: ListShape = {}): Responder {
  return (s) => {
    if (isCountsRead(s)) {
      return [
        {
          total: 0,
          matched: 0,
          live: 0,
          former_keys: 0,
          docs: 0,
          studio: 0,
          status: 0,
          ...shape.counts,
        },
      ];
    }
    if (isCreatorsRead(s)) return shape.creators ?? [];
    if (isPageRead(s)) return shape.keys ?? [];
    if (isKeyProjects(s)) return shape.projects ?? [];
    return [];
  };
}

export const listedRow = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  storedKey({ state: 'live', display_name: 'Nia Reed', email: 'nia@example.com', ...over });

export const API_ENV = { DREFYN_API_RATE_LIMIT_KEY: base64url(new Uint8Array(32).fill(4)) };

export function countingLimiter(): ApiKeyFailureLimiter & { readonly keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    reserve(clientKey) {
      keys.push(clientKey);
      return Promise.resolve();
    },
  };
}

export function verifierFor(respond: Responder, given?: ApiKeyFailureLimiter) {
  const counting = countingLimiter();
  const scripted = scriptedStore(respond);
  const { logger, lines } = capturingLogger();
  const verifier = createApiKeyVerifier(API_ENV, {
    store: scripted.store,
    limiter: given ?? counting,
    logger,
  });
  // The counting limiter's calls; empty when the test hands in its own.
  return { verifier, scripted, lines, limiter: counting };
}
