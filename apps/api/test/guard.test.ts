import type * as DbModule from '@drefyn/db';
import { AuthError, rateKeyForIp } from '@drefyn/auth';
import { toPublicId, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type ApiDeps } from '../src/app.ts';
import { guard, tenantOf, type GuardOptions } from '../src/guard.ts';
import {
  DOCS_PROJECT,
  GOOD,
  KEY_ID,
  LISTED,
  ORG,
  OTHER_PROJECT,
  PROJECT,
  PROJECT_PUBLIC,
  SOCKET_IP,
  actor,
  fakeDeps,
  fakeKeys,
  socketEnv,
} from './support.ts';

// Projects as RLS shows them to each organization: ORG sees its own, nobody sees another's.
const PROJECTS = new Map<string, string>([
  [`${ORG}:${PROJECT}`, 'studio'],
  [`${ORG}:${OTHER_PROJECT}`, 'studio'],
  [`${ORG}:${DOCS_PROJECT}`, 'docs'],
]);

const lookups: { organizationId: OrganizationId; projectId: ProjectId }[] = [];
let lookupFails = false;

vi.mock('@drefyn/db', async (original) => {
  const actual = await original<typeof DbModule>();
  return {
    ...actual,
    withOrganization: (
      _db: unknown,
      org: { organizationId: OrganizationId },
      work: (tx: unknown) => Promise<unknown>,
    ) => {
      if (lookupFails) return Promise.reject(new Error('connection terminated'));
      let id = '' as ProjectId;
      const chain = {
        selectFrom: () => chain,
        select: () => chain,
        where: (column: string, _op: string, value: string) => {
          if (column === 'id') id = value as ProjectId;
          return chain;
        },
        executeTakeFirst: () => {
          lookups.push({ organizationId: org.organizationId, projectId: id });
          const product = PROJECTS.get(`${org.organizationId}:${id}`);
          return Promise.resolve(product === undefined ? undefined : { product });
        },
      };
      return work(chain);
    },
  };
});

beforeEach(() => {
  lookups.length = 0;
  lookupFails = false;
});

function appWith(deps: ApiDeps, options: GuardOptions = { scope: 'studio:content.read' }) {
  const app = createApp(deps);
  app.get('/v1/projects/:projectId/things', guard(deps, options), (c) => {
    const tenant = tenantOf(c);
    return c.json({
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
      keyId: tenant.keyId,
    });
  });
  return app;
}

async function call(
  deps: ApiDeps,
  init: { key?: string; project?: string; query?: string; options?: GuardOptions } = {},
) {
  const headers: Record<string, string> = {};
  if (init.key !== undefined) headers['authorization'] = init.key;
  const path = `/v1/projects/${init.project ?? PROJECT_PUBLIC}/things${init.query ?? ''}`;
  const response = await appWith(deps, init.options).request(path, { headers }, socketEnv());
  const body = (await response.json()) as { error?: { code: string } } & Record<string, unknown>;
  return { status: response.status, code: body.error?.code, body, response };
}

describe('guard', () => {
  it('passes a proved tenant to the handler', async () => {
    const { deps, seen } = fakeDeps();
    const result = await call(deps, { key: GOOD });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ organizationId: ORG, projectId: PROJECT, keyId: KEY_ID });
    expect(seen[0]?.ip).toBe(SOCKET_IP);
    expect(lookups).toEqual([{ organizationId: ORG, projectId: PROJECT }]);
  });

  it('refuses a missing or bad key with 401 and never looks up a project', async () => {
    const { deps, reserve } = fakeDeps();
    for (const key of [undefined, 'Bearer nope']) {
      const result = await call(deps, key === undefined ? {} : { key });
      expect(result.status).toBe(401);
      expect(result.code).toBe('auth.api_key_invalid');
    }
    expect(lookups).toEqual([]);
    // The verifier counts its own refusals; the guard does not count them twice.
    expect(reserve).not.toHaveBeenCalled();
  });

  it('hands the verifier the whole URL, so a key in the query string is refused there', async () => {
    const { deps, seen } = fakeDeps();
    await call(deps, { key: GOOD, query: '?api_key=drf_ak_x' });
    expect(String(seen[0]?.url)).toContain('?api_key=drf_ak_x');
  });

  it('refuses a key without the scope with 403 and counts the failure', async () => {
    const { deps, reserve } = fakeDeps();
    const result = await call(deps, {
      key: GOOD,
      options: { scope: 'studio:content.write' },
    });
    expect(result.status).toBe(403);
    expect(result.code).toBe('auth.api_key_scope');
    expect(reserve).toHaveBeenCalledWith(rateKeyForIp(SOCKET_IP));
    expect(lookups).toEqual([]);
  });

  it('answers 404 for a project id that does not parse, and counts it', async () => {
    const { deps, reserve } = fakeDeps();
    for (const project of ['nope', toPublicId('org', ORG)]) {
      const result = await call(deps, { key: GOOD, project });
      expect(result.status).toBe(404);
      expect(result.code).toBe('api.not_found');
    }
    expect(reserve).toHaveBeenCalledTimes(2);
  });

  // RLS hides another organization's project, so it reads exactly like one that never existed.
  it('answers 404 for a project of another organization, looked up as the key organization', async () => {
    const { deps, reserve } = fakeDeps();
    const stranger = toPublicId('prj', '01a14984-4476-77ce-9335-2c3c3a59aaff' as ProjectId);
    const result = await call(deps, { key: GOOD, project: stranger });
    expect(result.status).toBe(404);
    expect(result.code).toBe('api.not_found');
    expect(lookups[0]?.organizationId).toBe(ORG);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('answers 404 for a project of another product', async () => {
    const { deps } = fakeDeps();
    const result = await call(deps, { key: GOOD, project: toPublicId('prj', DOCS_PROJECT) });
    expect(result.status).toBe(404);
  });

  it('refuses a listed key outside its projects with 403', async () => {
    const { deps, reserve } = fakeDeps();
    const refused = await call(deps, { key: LISTED });
    expect(refused.status).toBe(403);
    expect(refused.code).toBe('auth.api_key_scope');
    expect(reserve).toHaveBeenCalledTimes(1);
    const allowed = await call(deps, { key: LISTED, project: toPublicId('prj', OTHER_PROJECT) });
    expect(allowed.status).toBe(200);
  });

  it('answers 429 with Retry-After once the client is over its failure limit', async () => {
    const { deps, reserve } = fakeDeps();
    reserve.mockRejectedValue(new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 42 }));
    const result = await call(deps, { key: GOOD, options: { scope: 'studio:content.write' } });
    expect(result.status).toBe(429);
    expect(result.code).toBe('auth.rate_limited');
    expect(result.response.headers.get('retry-after')).toBe('42');
  });

  it('answers 503 when the failure limiter cannot count', async () => {
    const { deps, reserve } = fakeDeps();
    reserve.mockRejectedValue(new AuthError('AUTH_UNAVAILABLE'));
    const result = await call(deps, { key: GOOD, options: { scope: 'studio:content.write' } });
    expect(result.status).toBe(503);
    expect(result.code).toBe('auth.unavailable');
  });

  it('answers 503 when the project lookup fails, without counting a failure', async () => {
    const { deps, reserve } = fakeDeps();
    lookupFails = true;
    const result = await call(deps, { key: GOOD });
    expect(result.status).toBe(503);
    expect(result.code).toBe('api.unavailable');
    expect(reserve).not.toHaveBeenCalled();
  });

  it('answers 404 while the route flag is off, and asks with both ids', async () => {
    const { deps, isOn } = fakeDeps();
    isOn.mockResolvedValue(false);
    const limit = vi.fn(() => Promise.resolve({ ok: true as const }));
    const result = await call(deps, {
      key: GOOD,
      options: { scope: 'studio:content.read', flag: 'product.studio', limit },
    });
    expect(result.status).toBe(404);
    expect(isOn).toHaveBeenCalledWith('product.studio', {
      organizationId: ORG,
      projectId: PROJECT,
    });
    expect(limit).not.toHaveBeenCalled();
  });

  it('serves the route while the flag is on', async () => {
    const { deps } = fakeDeps();
    const result = await call(deps, {
      key: GOOD,
      options: { scope: 'studio:content.read', flag: 'product.studio' },
    });
    expect(result.status).toBe(200);
  });

  it('reads a flag that fails as off and says so in the log', async () => {
    const { deps, isOn, logs } = fakeDeps();
    isOn.mockRejectedValue(new Error('flagd down'));
    const result = await call(deps, {
      key: GOOD,
      options: { scope: 'studio:content.read', flag: 'product.studio' },
    });
    expect(result.status).toBe(404);
    expect(logs).toContainEqual({
      level: 'warn',
      event: 'api.flag_failed',
      fields: { flag: 'product.studio' },
    });
  });

  it('answers 429 api.limit_reached when the plan limit refuses', async () => {
    const { deps } = fakeDeps();
    const seen: unknown[] = [];
    const result = await call(deps, {
      key: GOOD,
      options: {
        scope: 'studio:content.read',
        limit: (tenant) => {
          seen.push(tenant);
          return Promise.resolve({ ok: false, retryAfterSeconds: 30 });
        },
      },
    });
    expect(result.status).toBe(429);
    expect(result.code).toBe('api.limit_reached');
    expect(result.response.headers.get('retry-after')).toBe('30');
    expect(seen).toEqual([
      { organizationId: ORG, projectId: PROJECT, keyId: KEY_ID, scopes: ['studio:content.read'] },
    ]);
    const bare = await call(deps, {
      key: GOOD,
      options: { scope: 'studio:content.read', limit: () => Promise.resolve({ ok: false }) },
    });
    expect(bare.response.headers.get('retry-after')).toBe('1');
  });

  it('serves the route when the plan limit allows it', async () => {
    const { deps } = fakeDeps();
    const result = await call(deps, {
      key: GOOD,
      options: { scope: 'studio:content.read', limit: () => Promise.resolve({ ok: true }) },
    });
    expect(result.status).toBe(200);
  });

  describe('plan feature', () => {
    it('answers 403 api.not_entitled when the plan lacks the feature, without counting it', async () => {
      const { deps, reserve } = fakeDeps();
      const seen: unknown[] = [];
      const result = await call(deps, {
        key: GOOD,
        options: {
          scope: 'studio:content.read',
          entitled: (tenant) => {
            seen.push(tenant);
            return Promise.resolve(false);
          },
        },
      });
      expect(result.status).toBe(403);
      expect(result.code).toBe('api.not_entitled');
      expect(seen).toEqual([
        { organizationId: ORG, projectId: PROJECT, keyId: KEY_ID, scopes: ['studio:content.read'] },
      ]);
      // A plan refusal says nothing an attacker could walk, so it is not a failed check.
      expect(reserve).not.toHaveBeenCalled();
    });

    it('serves the route when the plan has the feature', async () => {
      const { deps } = fakeDeps();
      const result = await call(deps, {
        key: GOOD,
        options: { scope: 'studio:content.read', entitled: () => Promise.resolve(true) },
      });
      expect(result.status).toBe(200);
    });

    it('fails closed with 503 when the plan cannot be read, and logs no detail', async () => {
      const { deps, logs } = fakeDeps();
      const result = await call(deps, {
        key: GOOD,
        options: {
          scope: 'studio:content.read',
          entitled: () => Promise.reject(new Error('connection to 10.0.0.5 refused')),
        },
      });
      expect(result.status).toBe(503);
      expect(result.code).toBe('api.unavailable');
      expect(logs).toContainEqual({
        level: 'warn',
        event: 'api.entitlement_failed',
        fields: { organizationId: toPublicId('org', ORG), projectId: PROJECT_PUBLIC },
      });
    });
  });

  it('runs the checks in the fixed order', async () => {
    const order: string[] = [];
    const base = fakeDeps();
    const { keys } = fakeKeys({ [GOOD]: actor() });
    const deps: ApiDeps = {
      ...base.deps,
      keys: {
        ...keys,
        verifyApiRequest: (request) => {
          order.push('key');
          return keys.verifyApiRequest(request);
        },
      },
      flags: {
        ...base.deps.flags,
        isOn: () => {
          order.push(`project looked up: ${String(lookups.length)}`, 'flag');
          return Promise.resolve(true);
        },
      },
    };
    const app = createApp(deps);
    app.get(
      '/v1/projects/:projectId/things',
      guard(deps, {
        scope: 'studio:content.read',
        flag: 'product.studio',
        entitled: () => {
          order.push('plan');
          return Promise.resolve(true);
        },
        limit: () => {
          order.push('limit');
          return Promise.resolve({ ok: true });
        },
      }),
      (c) => {
        order.push('handler');
        return c.json({});
      },
    );
    await app.request(
      `/v1/projects/${PROJECT_PUBLIC}/things`,
      { headers: { authorization: GOOD } },
      socketEnv(),
    );
    expect(order).toEqual(['key', 'project looked up: 1', 'flag', 'plan', 'limit', 'handler']);
  });

  it('fails a handler that reads a tenant without a guard, as 500', async () => {
    const { deps, logs } = fakeDeps();
    const app = createApp(deps);
    app.get('/v1/projects/:projectId/open', (c) => c.json(tenantOf(c)));
    const response = await app.request(`/v1/projects/${PROJECT_PUBLIC}/open`, {}, socketEnv());
    expect(response.status).toBe(500);
    expect(logs).toContainEqual({
      level: 'error',
      event: 'api.unhandled_error',
      fields: { error: 'Error' },
    });
  });
});
