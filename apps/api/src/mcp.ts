import { checkApiKeyScope, rateKeyForIp } from '@drefyn/auth';
import { withOrganization, type Database } from '@drefyn/db';
import {
  hasFeature,
  limitFor,
  TIERS,
  UNLIMITED,
  type FeatureKey,
  type Tier,
} from '@drefyn/entitlements';
import { createMcpServer, handleMcpHttp, type McpLogger, type McpRetrieval } from '@drefyn/mcp';
import { toPublicId, type OrganizationId, type ProjectId, type TenantRef } from '@drefyn/tenancy';
import type { Context, Hono, Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ApiDeps, ApiEnv } from './app.ts';
import { ApiError, apiErrorFromAuth, errorResponse } from './errors.ts';
import type { LimitDecision, ReleaseFlagName } from './guard.ts';
import type { ApiLogger } from './log.ts';
import type { ApiScope } from './scopes.ts';

const SCOPE: ApiScope = 'docs:pages.read';
const FEATURE = 'docs.mcp' satisfies FeatureKey;
const LIMIT_KEY = 'docs.mcp_requests_per_month';
// Long enough that a client backs off while someone looks, short enough to notice the switch
// coming back on.
const STOPPED_RETRY_SECONDS = 60;

export interface McpProject {
  readonly product: string;
  readonly tier: Tier;
}

// What the routes read about the key's project: its product and its organization's plan.
export interface McpStore {
  project(organizationId: OrganizationId, projectId: ProjectId): Promise<McpProject | null>;
}

// Counts one MCP request against the organization's monthly cap.
export interface McpMeter {
  count(tenant: TenantRef, tier: Tier): Promise<LimitDecision>;
}

export interface McpRouteOptions {
  readonly retrieval: McpRetrieval;
  readonly store: McpStore;
  readonly meter?: McpMeter;
  readonly hasFeature?: (tier: Tier, feature: typeof FEATURE) => boolean;
  readonly config: {
    readonly maxBodyBytes: number;
    readonly host: string | null;
  };
}

const isTier = (value: string): value is Tier => (TIERS as readonly string[]).includes(value);

// Read under the key's own organization, so RLS hides every other organization's projects and
// one that belongs elsewhere reads as missing.
export function appMcpStore(db: Database): McpStore {
  return {
    project: async (organizationId, projectId) => {
      const row = await withOrganization(db, { organizationId }, (tx) =>
        tx
          .selectFrom('projects')
          .innerJoin('organizations', 'organizations.organization_id', 'projects.organization_id')
          .select(['projects.product', 'organizations.plan_tier'])
          .where('projects.id', '=', projectId)
          .where('projects.organization_id', '=', organizationId)
          .executeTakeFirst(),
      );
      if (row === undefined) return null;
      // The database check holds the column to the plan table, so anything else is a fault.
      if (!isTier(row.plan_tier)) throw new Error('stored plan tier is unknown');
      return { product: row.product, tier: row.plan_tier };
    },
  };
}

// Answers from the plan alone. Unlimited needs no count. A cap of 0, which every hosted tier has
// until calibration, refuses. A numbered cap needs a stored monthly counter, which does not exist
// yet, so it fails closed rather than serving uncounted.
export function planMeter(deps: {
  readonly logger: ApiLogger;
  readonly limitFor?: (tier: Tier, key: typeof LIMIT_KEY) => number | typeof UNLIMITED;
}): McpMeter {
  const limitOf = deps.limitFor ?? limitFor;
  return {
    count: (tenant, tier) => {
      const limit = limitOf(tier, LIMIT_KEY);
      if (limit === UNLIMITED) return Promise.resolve({ ok: true });
      if (limit > 0) {
        deps.logger.warn('api.mcp_meter_missing', {
          organizationId: tenant.organizationId,
          projectId: tenant.projectId,
          limit,
        });
      }
      return Promise.resolve({ ok: false });
    },
  };
}

const mcpLogger = (logger: ApiLogger): McpLogger => ({
  info: (event, fields) => {
    logger.info(event, fields);
  },
  warn: (event, fields) => {
    logger.warn(event, fields);
  },
});

function methodNotAllowed(): Response {
  const response = errorResponse(new ApiError('api.method_not_allowed'));
  response.headers.set('allow', 'POST');
  return response;
}

async function flagOn(deps: ApiDeps, name: ReleaseFlagName, tenant: TenantRef) {
  try {
    return await deps.flags.isOn(name, {
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
  } catch {
    // Off for the release flag, stopped for the kill switch: both fail safe.
    deps.logger.warn('api.flag_failed', { flag: name });
    return false;
  }
}

// POST /mcp, and POST / on the MCP host. The order matches every /v1 route: key, scope,
// project, flag, plan, then the work. The project is the one the key lists and never anything
// the request says, so a client cannot ask for another project's docs.
export function mountMcp(app: Hono<ApiEnv>, deps: ApiDeps, options: McpRouteOptions): void {
  const meter = options.meter ?? planMeter({ logger: deps.logger });
  const entitled = options.hasFeature ?? hasFeature;
  const { host, maxBodyBytes } = options.config;

  const capped = bodyLimit({
    maxSize: maxBodyBytes,
    onError: () => errorResponse(new ApiError('api.too_large')),
  });

  const serve = async (c: Context<ApiEnv>): Promise<Response> => {
    const ip = c.get('clientIp');
    // Every refusal after the key is proved counts against the client, so walking scopes
    // with a good key is limited like guessing keys.
    const refuse = async (): Promise<never> => {
      try {
        await deps.failures.reserve(rateKeyForIp(ip));
      } catch (limited) {
        throw apiErrorFromAuth(limited);
      }
      throw new ApiError('auth.api_key_scope');
    };

    const verified = await deps.keys.verifyApiRequest({
      authorization: c.req.header('authorization'),
      url: c.req.url,
      ip,
    });
    if (!verified.ok) throw apiErrorFromAuth(verified.error);
    const actor = verified.value;
    if (!checkApiKeyScope(actor, SCOPE).ok) return refuse();

    // A key for every project, or for several, cannot say whose docs to read.
    const listed = actor.projectIds;
    const projectId = listed !== 'all' && listed.length === 1 ? listed[0] : undefined;
    if (projectId === undefined) return refuse();
    let project: McpProject | null;
    try {
      project = await options.store.project(actor.organizationId, projectId);
    } catch {
      throw new ApiError('api.unavailable');
    }
    if (project?.product !== 'docs') return refuse();

    const tenant: TenantRef = { organizationId: actor.organizationId, projectId };
    c.set('proved', {
      organizationId: toPublicId('org', tenant.organizationId),
      projectId: toPublicId('prj', tenant.projectId),
      keyId: toPublicId('key', actor.keyId),
    });

    if (!(await flagOn(deps, 'mcp.v1', tenant))) throw new ApiError('api.not_found');
    if (!(await flagOn(deps, 'mcp.serve', tenant))) {
      throw new ApiError('api.unavailable', { retryAfterSeconds: STOPPED_RETRY_SECONDS });
    }
    if (!entitled(project.tier, FEATURE)) throw new ApiError('api.not_entitled');
    let decision: LimitDecision;
    try {
      decision = await meter.count(tenant, project.tier);
    } catch {
      throw new ApiError('api.unavailable');
    }
    if (!decision.ok) {
      throw new ApiError(
        'api.limit_reached',
        decision.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: decision.retryAfterSeconds },
      );
    }

    const server = createMcpServer({
      retrieval: options.retrieval,
      tenant,
      logger: mcpLogger(deps.logger),
    });
    return handleMcpHttp(c.req.raw, server, { maxBodyBytes });
  };

  // URL parsing lower cases the name and drops the port.
  const onMcpHost = (c: Context<ApiEnv>) => host !== null && new URL(c.req.url).hostname === host;
  const mcpHostOnly = async (c: Context<ApiEnv>, next: Next) => {
    if (!onMcpHost(c)) throw new ApiError('api.not_found');
    await next();
  };

  app.post('/mcp', capped, serve);
  app.all('/mcp', methodNotAllowed);
  app.post('/', mcpHostOnly, capped, serve);
  app.all('/', mcpHostOnly, methodNotAllowed);
}
