import { createApiKeyFailureLimiter, createApiKeyVerifier, parseApiAuthConfig } from '@drefyn/auth';
import { toPublicId, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import type { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp, type ApiDeps, type ApiEnv } from '../../src/app.ts';
import { guard, tenantOf } from '../../src/guard.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

const fresh = harness();
let h: Harness;
let app: Hono<ApiEnv>;

let orgA: OrganizationId;
let orgB: OrganizationId;
let projectA: ProjectId;
let projectA2: ProjectId;
let docsA: ProjectId;
let projectB: ProjectId;
let readA: string;
let writeOnlyA: string;
let listedA: string;
let readB: string;

// Small, so the limiter test needs a handful of requests rather than sixty.
const FAIL_LIMIT = 5;

let addresses = 0;
// A new documentation address per test, so no two tests share a failure window.
function nextIp(): string {
  addresses += 1;
  return `198.51.100.${String(addresses)}`;
}

async function call(path: string, ip: string, key?: string) {
  const response = await app.request(
    path,
    { headers: key === undefined ? {} : { authorization: `Bearer ${key}` } },
    { incoming: { socket: { remoteAddress: ip } } },
  );
  const body = (await response.json()) as { error?: { code: string } } & Record<string, unknown>;
  return { status: response.status, code: body.error?.code, body, response };
}

const route = (project: ProjectId) => `/v1/projects/${toPublicId('prj', project)}/probe`;

// Windows are a minute long by the database clock. A run that straddled a boundary would split
// across two, so the limit test starts with at least 10 seconds left.
async function awayFromMinuteEdge(): Promise<void> {
  const left = Number(await h.sql(`select 60 - floor(extract(epoch from now()))::int % 60;`));
  if (left < 10) await new Promise((resolve) => setTimeout(resolve, (left + 1) * 1000));
}

describeWithStack('key checks against Postgres with real keys', () => {
  beforeAll(async () => {
    h = await fresh();
    orgA = await h.organization();
    orgB = await h.organization();
    projectA = await h.project(orgA);
    projectA2 = await h.project(orgA);
    docsA = await h.project(orgA, 'docs');
    projectB = await h.project(orgB);
    readA = await h.key(orgA, ['studio:content.read']);
    writeOnlyA = await h.key(orgA, ['studio:content.write']);
    listedA = await h.key(orgA, ['studio:content.read'], [projectA2]);
    readB = await h.key(orgB, ['studio:content.read']);

    const env = { ...h.env, DREFYN_AUTH_RATE_API_KEY_FAIL: `${String(FAIL_LIMIT)}/1m` };
    const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const failures = createApiKeyFailureLimiter({ db: h.db, config: parseApiAuthConfig(env) });
    const deps: ApiDeps = {
      db: h.db,
      published: h.published,
      keys: createApiKeyVerifier(env, { db: h.db, limiter: failures, logger }),
      failures,
      flags: {
        isOn: () => Promise.resolve(true),
        evaluate: () => Promise.reject(new Error('not used')),
        close: () => Promise.resolve(),
      },
      logger,
      config: { hops: 0, viewerHeader: false, maxBodyBytes: 1024 },
    };
    app = createApp(deps);
    app.get('/v1/projects/:projectId/probe', guard(deps, { scope: 'studio:content.read' }), (c) => {
      const tenant = tenantOf(c);
      return c.json({ organizationId: tenant.organizationId, projectId: tenant.projectId });
    });
  });

  it('serves a key with the scope on its own project', async () => {
    const before = await h.failures();
    const result = await call(route(projectA), nextIp(), readA);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ organizationId: orgA, projectId: projectA });
    expect(await h.failures()).toBe(before);
  });

  describe('each refusal returns its code and reaches the limiter', () => {
    it('a key in the query string: 401, even with a good key in the header', async () => {
      const before = await h.failures();
      const result = await call(`${route(projectA)}?api_key=${readA}`, nextIp(), readA);
      expect(result.status).toBe(401);
      expect(result.code).toBe('auth.api_key_invalid');
      expect(await h.failures()).toBe(before + 1);
    });

    it('a bad key: 401', async () => {
      const before = await h.failures();
      const tampered = `${readA.slice(0, -1)}${readA.endsWith('a') ? 'b' : 'a'}`;
      const result = await call(route(projectA), nextIp(), tampered);
      expect(result.status).toBe(401);
      expect(result.code).toBe('auth.api_key_invalid');
      expect(await h.failures()).toBe(before + 1);
    });

    it('no key at all: 401', async () => {
      const before = await h.failures();
      const result = await call(route(projectA), nextIp());
      expect(result.status).toBe(401);
      expect(await h.failures()).toBe(before + 1);
    });

    it('a key without the scope: 403', async () => {
      const before = await h.failures();
      const result = await call(route(projectA), nextIp(), writeOnlyA);
      expect(result.status).toBe(403);
      expect(result.code).toBe('auth.api_key_scope');
      expect(await h.failures()).toBe(before + 1);
    });

    it('a listed key outside its projects: 403', async () => {
      const before = await h.failures();
      expect((await call(route(projectA2), nextIp(), listedA)).status).toBe(200);
      const result = await call(route(projectA), nextIp(), listedA);
      expect(result.status).toBe(403);
      expect(result.code).toBe('auth.api_key_scope');
      expect(await h.failures()).toBe(before + 1);
    });
  });

  describe('tenancy', () => {
    // RLS hides the other organization's project, so it reads as one that does not exist.
    it('a key for one organization gets 404 on another organization project', async () => {
      const before = await h.failures();
      const ab = await call(route(projectB), nextIp(), readA);
      expect(ab.status).toBe(404);
      expect(ab.code).toBe('api.not_found');
      const ba = await call(route(projectA), nextIp(), readB);
      expect(ba.status).toBe(404);
      expect(await h.failures()).toBe(before + 2);
    });

    it('answers the same for a project that never existed', async () => {
      const missing = await call(
        `/v1/projects/${toPublicId('prj', '01a14984-4476-77ce-9335-2c3c3a59ffff' as ProjectId)}/probe`,
        nextIp(),
        readA,
      );
      const foreign = await call(route(projectB), nextIp(), readA);
      expect(missing.status).toBe(foreign.status);
      expect(missing.body).toEqual(foreign.body);
    });

    it('a studio scope gets 404 on a docs project of its own organization', async () => {
      expect((await call(route(docsA), nextIp(), readA)).status).toBe(404);
    });
  });

  it('turns every kind of failure from one client into 429 past the limit', async () => {
    await awayFromMinuteEdge();
    const ip = nextIp();
    const kinds = [
      () => call(route(projectA), ip, 'drf_ak_nope'),
      () => call(route(projectA), ip, writeOnlyA),
      () => call(route(projectB), ip, readA),
    ];
    for (let i = 0; i < FAIL_LIMIT; i += 1) {
      const kind = kinds[i % kinds.length];
      if (kind === undefined) throw new Error('no kind');
      expect((await kind()).status).not.toBe(429);
    }
    const limited = await call(route(projectB), ip, readA);
    expect(limited.status).toBe(429);
    expect(limited.code).toBe('auth.rate_limited');
    expect(Number(limited.response.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another client is untouched.
    expect((await call(route(projectA), nextIp(), readA)).status).toBe(200);
  });
});
