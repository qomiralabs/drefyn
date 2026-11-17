import { AuthError, rateKeyForIp } from '@drefyn/auth';
import { limitFor, TIERS, UNLIMITED, type Tier } from '@drefyn/entitlements';
import type { FlagClient } from '@drefyn/flags';
import type { McpRetrieval } from '@drefyn/mcp';
import type { RetrieveResult } from '@drefyn/retrieval';
import { projectId, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type ApiDeps } from '../src/app.ts';
import type { LimitDecision } from '../src/guard.ts';
import {
  mountMcp,
  planMeter,
  type McpMeter,
  type McpProject,
  type McpRouteOptions,
  type McpStore,
} from '../src/mcp.ts';
import {
  DOCS_PROJECT,
  ORG,
  PROJECT,
  SOCKET_IP,
  actor,
  fakeDeps,
  fakeKeys,
  socketEnv,
} from './support.ts';

const KEY = 'docs:pages.read';
const MISSING_PROJECT = projectId('01a14984-4476-77ce-9335-2c3c3a59aa99');

const MCP = 'Bearer mcp';
const keys = fakeKeys({
  [MCP]: actor({ scopes: [KEY], projectIds: [DOCS_PROJECT] }),
  'Bearer all': actor({ scopes: [KEY], projectIds: 'all' }),
  'Bearer two': actor({ scopes: [KEY], projectIds: [DOCS_PROJECT, PROJECT] }),
  'Bearer none': actor({ scopes: [KEY], projectIds: [] }),
  'Bearer studio-project': actor({ scopes: [KEY], projectIds: [PROJECT] }),
  'Bearer missing': actor({ scopes: [KEY], projectIds: [MISSING_PROJECT] }),
  'Bearer no-scope': actor({ scopes: ['studio:content.read'], projectIds: [DOCS_PROJECT] }),
});

function tierWith(limit: number | typeof UNLIMITED): Tier {
  const found = TIERS.find((tier) => limitFor(tier, 'docs.mcp_requests_per_month') === limit);
  if (found === undefined) throw new Error('plan table changed');
  return found;
}
const selfHosted = tierWith(UNLIMITED);
const shut = tierWith(0);

const SEARCH: RetrieveResult = {
  pin: { version: 'latest', publishedAt: '2026-11-17T09:00:00.000Z' },
  ranking: 'lexical',
  hits: [],
};

interface Setup {
  readonly flags?: Partial<Record<string, boolean | Error>>;
  readonly projects?: ReadonlyMap<string, McpProject>;
  readonly storeFails?: boolean;
  readonly meter?: McpMeter;
  readonly hasFeature?: (tier: Tier, feature: 'docs.mcp') => boolean;
  readonly host?: string | null;
  readonly maxBodyBytes?: number;
  readonly retrieveThrows?: boolean;
}

function setup(over: Setup = {}) {
  const calls: { tenant: unknown; input: unknown }[] = [];
  const retrieval: McpRetrieval = {
    retrieve: (tenant, input) => {
      calls.push({ tenant, input });
      if (over.retrieveThrows === true) return Promise.reject(new Error('pool detail'));
      return Promise.resolve({ ok: true, value: SEARCH });
    },
    getPage: () => Promise.resolve({ ok: false, error: 'retrieval.not_found' }),
    listVersions: () =>
      Promise.resolve({
        ok: true,
        value: { versions: [{ label: 'latest', isDefault: true, deprecated: false }] },
      }),
  };
  const projects =
    over.projects ??
    new Map<string, McpProject>([
      [`${ORG}:${DOCS_PROJECT}`, { product: 'docs', tier: selfHosted }],
      [`${ORG}:${PROJECT}`, { product: 'studio', tier: selfHosted }],
    ]);
  const lookups: { organizationId: OrganizationId; projectId: ProjectId }[] = [];
  const store: McpStore = {
    project: (organizationId, project) => {
      lookups.push({ organizationId, projectId: project });
      if (over.storeFails === true) return Promise.reject(new Error('connection terminated'));
      return Promise.resolve(projects.get(`${organizationId}:${project}`) ?? null);
    },
  };
  const isOn = vi.fn<FlagClient['isOn']>((name) => {
    const value = over.flags?.[name] ?? true;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  });
  const made = fakeDeps({
    keys: keys.keys,
    flags: {
      isOn,
      evaluate: () => Promise.reject(new Error('unused')),
      close: () => Promise.resolve(),
    },
  });
  const deps: ApiDeps = made.deps;
  const app = createApp(deps);
  const options: McpRouteOptions = {
    retrieval,
    store,
    ...(over.meter === undefined ? {} : { meter: over.meter }),
    ...(over.hasFeature === undefined ? {} : { hasFeature: over.hasFeature }),
    config: {
      maxBodyBytes: over.maxBodyBytes ?? 65_536,
      host: over.host === undefined ? 'mcp.example.com' : over.host,
    },
  };
  mountMcp(app, deps, options);
  return { app, calls, lookups, isOn, logs: made.logs, reserve: made.reserve };
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 't', version: '0' },
  },
};

const search = (query: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'search_docs', arguments: { query } },
});

async function send(
  app: ReturnType<typeof setup>['app'],
  options: {
    readonly path?: string;
    readonly method?: string;
    readonly key?: string;
    readonly body?: unknown;
    readonly host?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    host: options.host ?? 'api.example.com',
  };
  if (options.key !== undefined) headers['authorization'] = options.key;
  const method = options.method ?? 'POST';
  const response = await app.request(
    `http://${headers['host'] ?? ''}${options.path ?? '/mcp'}`,
    {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(options.body ?? initialize) } : {}),
    },
    socketEnv(),
  );
  const text = await response.text();
  const json = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
  const error = json?.['error'] as { code?: unknown } | undefined;
  return { response, status: response.status, json, code: error?.code };
}

describe('POST /mcp with a key for one docs project', () => {
  it('answers initialize and tool calls in JSON, for the key project only', async () => {
    const { app, calls } = setup();
    const init = await send(app, { key: MCP });
    expect(init.status).toBe(200);
    expect(init.response.headers.get('content-type')).toContain('application/json');
    expect(init.response.headers.get('mcp-session-id')).toBeNull();
    const called = await send(app, { key: MCP, body: search('install') });
    expect(called.status).toBe(200);
    expect((called.json?.['result'] as { structuredContent: unknown }).structuredContent).toEqual(
      SEARCH,
    );
    expect(calls).toEqual([
      { tenant: { organizationId: ORG, projectId: DOCS_PROJECT }, input: { query: 'install' } },
    ]);
  });

  it('works with the official client', async () => {
    const { app } = setup();
    const transport = new StreamableHTTPClientTransport(new URL('http://api.example.com/mcp'), {
      requestInit: { headers: { authorization: MCP } },
      fetch: (input, init) =>
        Promise.resolve(app.request(input instanceof URL ? input.href : input, init, socketEnv())),
    });
    const client = new Client({ name: 'stock', version: '0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['search_docs', 'get_page', 'list_versions']);
    const result = await client.callTool({ name: 'get_page', arguments: { path: '/x' } });
    expect(result.structuredContent).toEqual({ code: 'retrieval.not_found' });
    await client.close();
  });

  it('turns a library that throws into a tool error and a warning with ids only', async () => {
    const { app, logs } = setup({ retrieveThrows: true });
    const called = await send(app, { key: MCP, body: search('question-canary-66') });
    expect(called.status).toBe(200);
    const result = called.json?.['result'] as { isError: boolean; structuredContent: unknown };
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: 'retrieval.unavailable' },
    });
    expect(logs).toContainEqual({
      level: 'warn',
      event: 'mcp.tool_failed',
      fields: {
        organizationId: ORG,
        projectId: DOCS_PROJECT,
        tool: 'search_docs',
        error: 'Error',
      },
    });
    expect(JSON.stringify(logs)).not.toContain('question-canary');
  });

  it('logs ids and the route, never the question', async () => {
    const { app, logs } = setup();
    await send(app, { key: MCP, body: search('question-canary-55') });
    const request = logs.find((line) => line.event === 'api.request');
    expect(request?.fields).toMatchObject({ route: '/mcp', status: 200 });
    expect(request?.fields['organizationId']).toMatch(/^org_/);
    expect(request?.fields['projectId']).toMatch(/^prj_/);
    const tool = logs.find((line) => line.event === 'mcp.tool_call');
    expect(tool?.fields).toMatchObject({
      organizationId: ORG,
      projectId: DOCS_PROJECT,
      tool: 'search_docs',
      outcome: 'ok',
    });
    expect(JSON.stringify(logs)).not.toContain('question-canary');
  });
});

describe('methods', () => {
  it.each(['GET', 'DELETE', 'PUT', 'PATCH'])(
    '%s /mcp is 405 with Allow: POST, before any key check',
    async (method) => {
      const { app } = setup();
      const seen = keys.seen.length;
      const answer = await send(app, { method, key: MCP });
      expect(answer.status).toBe(405);
      expect(answer.code).toBe('api.method_not_allowed');
      expect(answer.response.headers.get('allow')).toBe('POST');
      expect(keys.seen.length).toBe(seen);
    },
  );
});

describe('refusals', () => {
  it.each([
    [undefined, 401, 'auth.api_key_invalid'],
    ['Bearer nonsense', 401, 'auth.api_key_invalid'],
  ])('key %s is %i', async (key, status, code) => {
    const { app, calls } = setup();
    const answer = await send(app, key === undefined ? {} : { key });
    expect([answer.status, answer.code]).toEqual([status, code]);
    expect(calls).toEqual([]);
  });

  it.each(['Bearer no-scope', 'Bearer all', 'Bearer two', 'Bearer none'])(
    '%s is 403 and counts against the client',
    async (key) => {
      const { app, calls, reserve, lookups } = setup();
      const answer = await send(app, { key });
      expect([answer.status, answer.code]).toEqual([403, 'auth.api_key_scope']);
      expect(reserve).toHaveBeenCalledWith(rateKeyForIp(SOCKET_IP));
      expect(lookups).toEqual([]);
      expect(calls).toEqual([]);
    },
  );

  it.each(['Bearer studio-project', 'Bearer missing'])(
    '%s reaches no docs project, so it is 403 and counted',
    async (key) => {
      const { app, reserve, lookups } = setup();
      const answer = await send(app, { key });
      expect([answer.status, answer.code]).toEqual([403, 'auth.api_key_scope']);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(lookups).toHaveLength(1);
    },
  );

  it('reads the project under the key organization', async () => {
    const { app, lookups } = setup();
    await send(app, { key: MCP });
    expect(lookups).toEqual([{ organizationId: ORG, projectId: DOCS_PROJECT }]);
  });

  it('is 503 when the project cannot be read', async () => {
    const { app } = setup({ storeFails: true });
    const answer = await send(app, { key: MCP });
    expect([answer.status, answer.code]).toEqual([503, 'api.unavailable']);
  });

  it('is 429 with Retry-After once the failure limiter says so', async () => {
    const { app, calls, reserve } = setup();
    reserve.mockRejectedValue(new AuthError('AUTH_RATE_LIMITED', { retryAfterSeconds: 42 }));
    const answer = await send(app, { key: 'Bearer all' });
    expect([answer.status, answer.code]).toEqual([429, 'auth.rate_limited']);
    expect(answer.response.headers.get('retry-after')).toBe('42');
    expect(calls).toEqual([]);
  });
});

describe('flags', () => {
  it('mcp.v1 off answers 404 as if the route did not exist', async () => {
    const { app, calls, isOn } = setup({ flags: { 'mcp.v1': false } });
    const answer = await send(app, { key: MCP, body: search('x') });
    expect([answer.status, answer.code]).toEqual([404, 'api.not_found']);
    expect(calls).toEqual([]);
    expect(isOn).toHaveBeenCalledWith('mcp.v1', {
      organizationId: ORG,
      projectId: DOCS_PROJECT,
    });
  });

  it('mcp.v1 unreadable is off', async () => {
    const { app } = setup({ flags: { 'mcp.v1': new Error('flagd down') } });
    expect((await send(app, { key: MCP })).status).toBe(404);
  });

  it('mcp.v1 on serves', async () => {
    const { app } = setup({ flags: { 'mcp.v1': true } });
    expect((await send(app, { key: MCP })).status).toBe(200);
  });

  it('the mcp.serve kill switch off answers 503 with Retry-After and serves nothing', async () => {
    const { app, calls } = setup({ flags: { 'mcp.serve': false } });
    const answer = await send(app, { key: MCP, body: search('x') });
    expect([answer.status, answer.code]).toEqual([503, 'api.unavailable']);
    expect(answer.response.headers.get('retry-after')).toBe('60');
    expect(calls).toEqual([]);
  });

  it('the kill switch unreadable stops serving', async () => {
    const { app } = setup({ flags: { 'mcp.serve': new Error('flagd down') } });
    expect((await send(app, { key: MCP })).status).toBe(503);
  });
});

describe('plan', () => {
  it('without the docs.mcp feature answers 403 api.not_entitled', async () => {
    const { app, calls } = setup({ hasFeature: () => false });
    const answer = await send(app, { key: MCP, body: search('x') });
    expect([answer.status, answer.code]).toEqual([403, 'api.not_entitled']);
    expect(calls).toEqual([]);
  });

  it('a refused meter answers 429 api.limit_reached with Retry-After', async () => {
    const count = vi.fn<McpMeter['count']>(() =>
      Promise.resolve<LimitDecision>({ ok: false, retryAfterSeconds: 3600 }),
    );
    const { app, calls } = setup({ meter: { count } });
    const answer = await send(app, { key: MCP, body: search('x') });
    expect([answer.status, answer.code]).toEqual([429, 'api.limit_reached']);
    expect(answer.response.headers.get('retry-after')).toBe('3600');
    expect(calls).toEqual([]);
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, projectId: DOCS_PROJECT }),
      selfHosted,
    );
  });

  it('a meter that fails answers 503, never serving uncounted', async () => {
    const { app, calls } = setup({
      meter: { count: () => Promise.reject(new Error('counter down')) },
    });
    const answer = await send(app, { key: MCP, body: search('x') });
    expect([answer.status, answer.code]).toEqual([503, 'api.unavailable']);
    expect(calls).toEqual([]);
  });

  it('the plan meter lets an unlimited plan through without counting', async () => {
    const meter = planMeter({ logger: fakeDeps().deps.logger });
    const tenant = { organizationId: ORG, projectId: DOCS_PROJECT };
    expect(await meter.count(tenant, selfHosted)).toEqual({ ok: true });
  });

  it('the plan meter refuses a plan whose cap is 0', async () => {
    const { app } = setup({
      projects: new Map([[`${ORG}:${DOCS_PROJECT}`, { product: 'docs', tier: shut }]]),
    });
    const answer = await send(app, { key: MCP });
    expect([answer.status, answer.code]).toEqual([429, 'api.limit_reached']);
  });

  it('the plan meter fails closed on a numbered cap it has no counter for', async () => {
    const made = fakeDeps();
    const meter = planMeter({ logger: made.deps.logger, limitFor: () => 1000 });
    const tenant = { organizationId: ORG, projectId: DOCS_PROJECT };
    expect(await meter.count(tenant, selfHosted)).toEqual({ ok: false });
    expect(made.logs).toContainEqual({
      level: 'warn',
      event: 'api.mcp_meter_missing',
      fields: { organizationId: ORG, projectId: DOCS_PROJECT, limit: 1000 },
    });
  });
});

describe('body cap', () => {
  it('refuses a body over DREFYN_MCP_MAX_BODY_BYTES with 413 before the key', async () => {
    const { app } = setup({ maxBodyBytes: 128 });
    const seen = keys.seen.length;
    const answer = await send(app, { key: MCP, body: search('x'.repeat(256)) });
    expect([answer.status, answer.code]).toEqual([413, 'api.too_large']);
    expect(keys.seen.length).toBe(seen);
  });
});

describe('the MCP host', () => {
  it('serves MCP at / when the host is the configured one', async () => {
    const { app } = setup();
    for (const host of ['mcp.example.com', 'MCP.example.com', 'mcp.example.com:443']) {
      const answer = await send(app, { path: '/', host, key: MCP });
      expect(answer.status).toBe(200);
    }
    const get = await send(app, { path: '/', host: 'mcp.example.com', method: 'GET' });
    expect([get.status, get.code]).toEqual([405, 'api.method_not_allowed']);
  });

  it('answers 404 at / on any other host, and when no host is set', async () => {
    const { app } = setup();
    for (const host of ['api.example.com', 'mcp.example.com.evil.test', 'xmcp.example.com']) {
      const answer = await send(app, { path: '/', host, key: MCP });
      expect([answer.status, answer.code]).toEqual([404, 'api.not_found']);
    }
    const unset = setup({ host: null });
    const answer = await send(unset.app, { path: '/', host: 'mcp.example.com', key: MCP });
    expect(answer.status).toBe(404);
    const get = await send(unset.app, { path: '/', host: 'mcp.example.com', method: 'GET' });
    expect(get.status).toBe(404);
  });

  it('keeps /mcp on the MCP host too', async () => {
    const { app } = setup();
    expect((await send(app, { host: 'mcp.example.com', key: MCP })).status).toBe(200);
  });
});
