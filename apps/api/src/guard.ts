import { checkApiKeyScope, rateKeyForIp, type ApiKeyActor } from '@drefyn/auth';
import { withOrganization } from '@drefyn/db';
import type { FlagName, PlanNameOf, Flags } from '@drefyn/flags';
import {
  parsePublicId,
  toPublicId,
  type IdOf,
  type OrganizationId,
  type ProjectId,
} from '@drefyn/tenancy';
import type { Context, MiddlewareHandler } from 'hono';
import type { ApiDeps, ApiEnv } from './app.ts';
import { ApiError, apiErrorFromAuth } from './errors.ts';
import { productOf, type ApiScope } from './scopes.ts';

// Proved by the guard and nothing else. A handler that reads it has a tenant it can trust.
export interface ProvedTenant {
  readonly organizationId: OrganizationId;
  readonly projectId: ProjectId;
  readonly keyId: IdOf<'key'>;
  readonly scopes: ApiKeyActor['scopes'];
}

export type ReleaseFlagName = Exclude<FlagName, PlanNameOf<Flags>>;

export type LimitDecision =
  { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds?: number };

export interface GuardOptions {
  readonly scope: ApiScope;
  // Off reads as a route that does not exist, so an unreleased feature says nothing about itself.
  readonly flag?: ReleaseFlagName;
  // Whether the organization's plan includes the route's feature. False is 403; a throw fails
  // closed as 503, since a plan that cannot be read says nothing either way.
  readonly entitled?: (tenant: ProvedTenant) => Promise<boolean>;
  // The plan limit for this request, read from entitlements by the route.
  readonly limit?: (tenant: ProvedTenant) => Promise<LimitDecision>;
}

const TENANTS = new WeakMap<object, ProvedTenant>();

// The tenant the guard proved for this request. Throws when the route skipped the guard, so a
// handler can never run on an unproved tenant by mistake.
export function tenantOf(c: Context): ProvedTenant {
  const tenant = TENANTS.get(c);
  if (tenant === undefined) throw new Error('route has no guard in front of it');
  return tenant;
}

function projectIdFrom(raw: string | undefined): ProjectId | null {
  if (raw === undefined) return null;
  try {
    return parsePublicId('prj', raw);
  } catch {
    return null;
  }
}

// The project's product, read under the key's own organization: RLS hides every other
// organization's projects, so one that belongs elsewhere reads as missing.
async function productOfProject(
  deps: ApiDeps,
  organizationId: OrganizationId,
  projectId: ProjectId,
): Promise<string | null> {
  const row = await withOrganization(deps.db, { organizationId }, (tx) =>
    tx
      .selectFrom('projects')
      .select('product')
      .where('id', '=', projectId)
      .where('organization_id', '=', organizationId)
      .executeTakeFirst(),
  );
  return row?.product ?? null;
}

async function flagOn(deps: ApiDeps, name: ReleaseFlagName, tenant: ProvedTenant) {
  try {
    return await deps.flags.isOn(name, {
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
  } catch {
    // Off is the safe value for every release flag.
    deps.logger.warn('api.flag_failed', { flag: name });
    return false;
  }
}

// The fixed order every /v1 project route runs: client address, key, scope, project, flag,
// plan feature, plan limit, then the handler. Each refusal of the scope or the project is
// counted against the client, so walking project ids with a good key is limited like guessing
// keys.
export function guard(
  deps: ApiDeps,
  options: GuardOptions,
): MiddlewareHandler<ApiEnv, '/v1/projects/:projectId/*'> {
  const wanted = productOf(options.scope);

  return async (c, next) => {
    const ip = c.get('clientIp');
    const refuse = async (error: ApiError): Promise<never> => {
      try {
        await deps.failures.reserve(rateKeyForIp(ip));
      } catch (limited) {
        throw apiErrorFromAuth(limited);
      }
      throw error;
    };

    const verified = await deps.keys.verifyApiRequest({
      authorization: c.req.header('authorization'),
      url: c.req.url,
      ip,
    });
    if (!verified.ok) throw apiErrorFromAuth(verified.error);
    const actor = verified.value;

    const held = checkApiKeyScope(actor, options.scope);
    if (!held.ok) return refuse(apiErrorFromAuth(held.error));

    const projectId = projectIdFrom(c.req.param('projectId'));
    if (projectId === null) return refuse(new ApiError('api.not_found'));
    let product: string | null;
    try {
      product = await productOfProject(deps, actor.organizationId, projectId);
    } catch {
      throw new ApiError('api.unavailable');
    }
    if (product !== wanted) return refuse(new ApiError('api.not_found'));

    const reach = checkApiKeyScope(actor, options.scope, projectId);
    if (!reach.ok) return refuse(apiErrorFromAuth(reach.error));

    const tenant: ProvedTenant = Object.freeze({
      organizationId: actor.organizationId,
      projectId,
      keyId: actor.keyId,
      scopes: actor.scopes,
    });
    c.set('proved', {
      organizationId: toPublicId('org', tenant.organizationId),
      projectId: toPublicId('prj', tenant.projectId),
      keyId: toPublicId('key', tenant.keyId),
    });

    if (options.flag !== undefined && !(await flagOn(deps, options.flag, tenant))) {
      throw new ApiError('api.not_found');
    }

    if (options.entitled !== undefined) {
      let allowed: boolean;
      try {
        allowed = await options.entitled(tenant);
      } catch {
        const { organizationId, projectId } = c.get('proved');
        deps.logger.warn('api.entitlement_failed', { organizationId, projectId });
        throw new ApiError('api.unavailable');
      }
      // Not counted as a failed check: the answer is the same for every project the key reaches.
      if (!allowed) throw new ApiError('api.not_entitled');
    }

    if (options.limit !== undefined) {
      const decision = await options.limit(tenant);
      if (!decision.ok) {
        throw new ApiError(
          'api.limit_reached',
          decision.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: decision.retryAfterSeconds },
        );
      }
    }

    TENANTS.set(c, tenant);
    await next();
  };
}
