import type { OrganizationId, TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import type { GitHubAppConfig } from './config.ts';
import { appJwt } from './jwt.ts';
import { loadAppSigner } from './private-key.ts';
import { ShortLivedToken, type TokenPermissions } from './token.ts';
import {
  callGitHub,
  defaultTransport,
  githubPolicy,
  type CallDeps,
  type CallOutcome,
  type GitHubTransport,
} from './transport.ts';
import {
  err,
  isGitHubId,
  noopLogger,
  ok,
  tenantFields,
  type GitHubLogger,
  type LogFields,
  type Result,
} from './types.ts';

// Every GitHub call today serves git sync, so tokens follow its release flag. Repository
// generation passes through the same broker once it has a flag of its own.
export const GITHUB_FLAG = 'docs.git_sync';

export const MINT_PURPOSES = Object.freeze(['import', 'sync', 'commit'] as const);
export type MintPurpose = (typeof MINT_PURPOSES)[number];

export interface MintRequest {
  readonly tenant: TenantRef;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly permissions: TokenPermissions;
  readonly purpose: MintPurpose;
}

export const BROKER_ERROR_CODES = Object.freeze([
  'github.disabled',
  'github.request_invalid',
  'github.permission_too_wide',
  'github.installation_not_owned',
  'github.repository_not_selected',
  'github.suspended',
  'github.rate_limited',
  'github.token_too_wide',
  'github.unavailable',
] as const);
export type BrokerErrorCode = (typeof BROKER_ERROR_CODES)[number];

export interface BrokerError {
  readonly code: BrokerErrorCode;
  readonly retryAfterSeconds?: number;
}

export interface Installation {
  readonly tenant: TenantRef;
  readonly installationId: number;
  readonly accountId: number;
  // The repositories this project may ask for tokens to, in ascending order.
  readonly repositoryIds: readonly number[];
  readonly suspended: boolean;
}

export interface InstallationReader {
  // Null when the installation is not recorded for this project.
  get(tenant: TenantRef, installationId: number): Promise<Installation | null>;
}

export interface BrokerDeps {
  readonly config: GitHubAppConfig;
  readonly installations: InstallationReader;
  // Shaped so the client from @drefyn/flags fits without this package depending on it.
  readonly flags: {
    isOn(
      name: typeof GITHUB_FLAG,
      ctx: { readonly organizationId: OrganizationId; readonly projectId: string },
    ): Promise<boolean>;
  };
  readonly logger?: GitHubLogger;
  readonly transport?: GitHubTransport;
  readonly clock?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface GitHubBroker {
  mintInstallationToken(
    request: MintRequest,
    signal?: AbortSignal,
  ): Promise<Result<ShortLivedToken, BrokerError>>;
  // Mints, lends the token to work, then revokes it whether work finished or threw.
  withInstallationToken<T>(
    request: MintRequest,
    work: (token: ShortLivedToken) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<Result<T, BrokerError>>;
}

const TOKEN_RESPONSE_BYTES = 64 * 1024;
const REVOKE_RESPONSE_BYTES = 4 * 1024;
// GitHub issues installation tokens for an hour; a minute covers clock drift.
const MAX_TOKEN_LIFETIME_MS = 61 * 60 * 1000;

// The only permission sets a job may ask for, by purpose. Anything else is wider than the job.
const ALLOWED: Readonly<Record<MintPurpose, readonly string[]>> = {
  import: ['contents:read'],
  sync: ['contents:read'],
  commit: ['contents:write', 'contents:write,pull_requests:write'],
};

const githubId = z.number().refine(isGitHubId);

const requestShape = z.strictObject({
  tenant: z.looseObject({
    organizationId: z.string().min(1),
    projectId: z.string().min(1),
  }),
  installationId: githubId,
  repositoryId: githubId,
  permissions: z.record(z.string(), z.unknown()),
  purpose: z.enum(MINT_PURPOSES),
});

const tokenShape = z.looseObject({
  token: z.string().regex(/^[\x21-\x7e]{1,255}$/),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z.record(z.string(), z.string()),
  repository_selection: z.string().optional(),
  repositories: z.array(z.looseObject({ id: z.number() })).optional(),
});

// A canonical 'name:level' list, so permission sets compare as text.
const permissionKey = (permissions: Readonly<Record<string, unknown>>): string =>
  Object.entries(permissions)
    .map(([name, level]) => `${name}:${typeof level === 'string' ? level : '?'}`)
    .sort()
    .join(',');

// Rebuilt from the checked key, so what GitHub is sent is exactly what was compared.
const permissionsOf = (key: string): TokenPermissions =>
  Object.fromEntries(key.split(',').map((pair) => pair.split(':'))) as TokenPermissions;

function retryAfter(headers: Headers, nowMs: number): number | undefined {
  const after = headers.get('retry-after');
  if (after !== null) return /^[0-9]{1,6}$/.test(after) ? Number(after) : undefined;
  const reset = headers.get('x-ratelimit-reset');
  if (reset !== null && /^[0-9]{1,12}$/.test(reset)) {
    return Math.max(0, Number(reset) - Math.floor(nowMs / 1000));
  }
  return undefined;
}

function refusalOf(status: number, headers: Headers, nowMs: number): BrokerError {
  const limited =
    status === 429 ||
    (status === 403 &&
      (headers.get('x-ratelimit-remaining') === '0' || headers.get('retry-after') !== null));
  if (limited) {
    const seconds = retryAfter(headers, nowMs);
    return seconds === undefined
      ? { code: 'github.rate_limited' }
      : { code: 'github.rate_limited', retryAfterSeconds: seconds };
  }
  switch (status) {
    case 403:
      return { code: 'github.suspended' };
    case 404:
      return { code: 'github.installation_not_owned' };
    case 422:
      return { code: 'github.repository_not_selected' };
    default:
      // 401 means GitHub refused our own App key: an operator problem, not the customer's.
      return { code: 'github.unavailable' };
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(body));
  } catch {
    return undefined;
  }
}

export function createGitHubBroker(deps: BrokerDeps): GitHubBroker {
  const signer = loadAppSigner(deps.config.privateKeyFile);
  const logger = deps.logger ?? noopLogger;
  const clock = deps.clock ?? Date.now;
  const call: CallDeps = {
    transport: deps.transport ?? defaultTransport,
    policy: githubPolicy(deps.config),
    random: deps.random ?? Math.random,
    sleep:
      deps.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        })),
  };
  const api = deps.config.apiUrl;

  const revoke = async (
    value: string,
    fields: LogFields,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const outcome = await callGitHub(call, {
      method: 'DELETE',
      url: `${api}/installation/token`,
      authorization: `token ${value}`,
      maxResponseBytes: REVOKE_RESPONSE_BYTES,
      signal,
    });
    if (outcome.kind === 'response' && outcome.response.status === 204) return;
    logger.warn('github.token_revoke_failed', {
      ...fields,
      ...(outcome.kind === 'response'
        ? { status: outcome.response.status }
        : { egress: outcome.egress }),
      attempts: outcome.attempts,
    });
  };

  const enabled = async (tenant: TenantRef): Promise<boolean> => {
    try {
      return await deps.flags.isOn(GITHUB_FLAG, {
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
      });
    } catch {
      logger.warn('github.flag_read_failed', tenantFields(tenant));
      return false;
    }
  };

  async function mint(
    raw: MintRequest,
    signal?: AbortSignal,
  ): Promise<Result<ShortLivedToken, BrokerError>> {
    const started = clock();
    const parsed = requestShape.safeParse(raw);
    if (!parsed.success) {
      logger.warn('github.token_refused', { code: 'github.request_invalid' });
      return err({ code: 'github.request_invalid' });
    }
    // The caller's own tenant object, so ids keep their brands; the shape above checked them.
    const tenant = raw.tenant;
    const { installationId, repositoryId, purpose } = parsed.data;
    const fields: LogFields = {
      ...tenantFields(tenant),
      installation_id: installationId,
      repository_id: repositoryId,
      purpose,
    };
    const refuse = (
      error: BrokerError,
      extra: LogFields = {},
    ): Result<ShortLivedToken, BrokerError> => {
      logger.warn('github.token_refused', { ...fields, code: error.code, ...extra });
      return err(error);
    };

    const asked = permissionKey(parsed.data.permissions);
    if (!ALLOWED[purpose].includes(asked)) return refuse({ code: 'github.permission_too_wide' });
    const permissions = permissionsOf(asked);
    if (!(await enabled(tenant))) return refuse({ code: 'github.disabled' });

    let installation: Installation | null;
    try {
      installation = await deps.installations.get(tenant, installationId);
    } catch {
      return refuse({ code: 'github.unavailable' }, { stage: 'installation' });
    }
    if (installation === null) return refuse({ code: 'github.installation_not_owned' });
    if (installation.suspended) return refuse({ code: 'github.suspended' });
    if (!installation.repositoryIds.includes(repositoryId)) {
      return refuse({ code: 'github.repository_not_selected' });
    }

    const outcome: CallOutcome = await callGitHub(call, {
      method: 'POST',
      url: `${api}/app/installations/${String(installationId)}/access_tokens`,
      authorization: `Bearer ${appJwt(signer, deps.config.appId, clock())}`,
      body: { repository_ids: [repositoryId], permissions },
      maxResponseBytes: TOKEN_RESPONSE_BYTES,
      signal,
    });
    if (outcome.kind === 'failed') {
      return refuse(
        { code: 'github.unavailable' },
        { egress: outcome.egress, attempts: outcome.attempts },
      );
    }
    const { response, attempts } = outcome;
    const at = { status: response.status, attempts };
    if (response.status !== 201)
      return refuse(refusalOf(response.status, response.headers, clock()), at);
    const body = tokenShape.safeParse(parseJson(response.body));
    if (!body.success) return refuse({ code: 'github.unavailable' }, { ...at, reason: 'response' });
    const expiresAt = new Date(body.data.expires_at);
    const now = clock();
    if (expiresAt.getTime() <= now || expiresAt.getTime() > now + MAX_TOKEN_LIFETIME_MS) {
      return refuse({ code: 'github.unavailable' }, { ...at, reason: 'expiry' });
    }

    // GitHub should never answer wider than asked, but a token is only as narrow as what it
    // says it is. Metadata read comes with every token and grants no content.
    const { metadata, ...granted } = body.data.permissions;
    const repositories = body.data.repositories?.map((r) => r.id) ?? [];
    const narrow =
      (metadata === undefined || metadata === 'read') &&
      permissionKey(granted) === asked &&
      body.data.repository_selection === 'selected' &&
      repositories.length === 1 &&
      repositories[0] === repositoryId;
    if (!narrow) {
      await revoke(body.data.token, fields, signal);
      return refuse({ code: 'github.token_too_wide' }, at);
    }

    logger.info('github.token_minted', {
      ...fields,
      permissions: asked,
      attempts,
      duration_ms: Math.max(0, Math.round(clock() - started)),
    });
    return ok(
      new ShortLivedToken({
        tenant,
        installationId,
        repositoryId,
        permissions,
        expiresAt,
        value: body.data.token,
      }),
    );
  }

  return Object.freeze({
    mintInstallationToken: mint,
    async withInstallationToken<T>(
      request: MintRequest,
      work: (token: ShortLivedToken) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<Result<T, BrokerError>> {
      const minted = await mint(request, signal);
      if (!minted.ok) return minted;
      const token = minted.value;
      try {
        return ok(await work(token));
      } finally {
        let header: string | null = null;
        try {
          header = token.authorization(clock());
        } catch {
          // Expired or already disposed: nothing left to revoke.
        }
        token.dispose();
        if (header !== null) {
          await revoke(
            header.slice('token '.length),
            {
              ...tenantFields(token.tenant),
              installation_id: token.installationId,
              repository_id: token.repositoryId,
            },
            signal,
          );
        }
      }
    },
  });
}
