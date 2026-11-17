import { randomUUID } from 'node:crypto';
import { limitFor, TIERS } from '@drefyn/entitlements';
import type { FlagClient } from '@drefyn/flags';
import {
  appTermStore,
  createRetrieval,
  createTermRebuild,
  DEFAULT_RETRIEVAL_CONFIG,
  publishedReader,
} from '@drefyn/retrieval';
import type { OrganizationId, ProjectId } from '@drefyn/tenancy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import type { Hono } from 'hono';
import { beforeAll, expect, it } from 'vitest';
import { createApiKeyFailureLimiter, createApiKeyVerifier, parseApiAuthConfig } from '@drefyn/auth';
import { createApp, type ApiDeps, type ApiEnv } from '../../src/app.ts';
import { appMcpStore, mountMcp } from '../../src/mcp.ts';
import { describeWithStack, harness, type Harness } from './support/harness.ts';

// One word per page, so a search for it finds the one page that holds it, wherever that is.
const OWN = 'zephyrownpage';
const SIBLING = 'quokkasiblingproject';
const FOREIGN = 'narwhalforeignorganization';
const PROTECTED = 'axolotlprotectedpage';
const DRAFT = 'pangolindraftonly';
const WORDS = [OWN, SIBLING, FOREIGN, PROTECTED, DRAFT] as const;

const fresh = harness();
let h: Harness;
let flagsOn: Record<string, boolean>;
let app: Hono<ApiEnv>;
let foreignNode: string;
const keys: Record<string, string> = {};

let addresses = 0;
const nextIp = () => {
  addresses += 1;
  return `198.51.100.${String(addresses)}`;
};

const text = (value: string) => `'${value.replaceAll("'", "''")}'`;

// A page written the way publish leaves it, as the superuser: the version, its chunk, and for
// anything but a draft the published copy with its visibility.
async function page(
  org: OrganizationId,
  project: ProjectId,
  slug: string,
  body: string,
  state: 'public' | 'protected' | 'draft',
): Promise<string> {
  const typeId = await h.sql(
    `insert into app.content_types (id, organization_id, project_id, family, key)
     values ('${randomUUID()}', '${org}', '${project}', 'docs_page', '${slug}') returning id;`,
  );
  const node = randomUUID();
  const version = randomUUID();
  const rows = [
    `insert into app.nodes (id, organization_id, project_id, family, type_id, parent_id, slug,
       order_key, lifecycle)
     values ('${node}', '${org}', '${project}', 'docs_page', '${typeId}', null, '${slug}',
       'a${node.replaceAll('-', '')}', 'draft');`,
    `insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
       ast_version, origin, actor, content, content_sha256, fields)
     values ('${version}', '${org}', '${project}', '${node}', 1, 1, 1, 'human',
       '{"kind":"system","job":"test"}', '{}', sha256('${version}'::bytea), '{"title":"${slug}"}');`,
    `insert into app.chunks (organization_id, project_id, node_id, version_id, ord, block_path,
       heading_path, body, body_sha256)
     values ('${org}', '${project}', '${node}', '${version}', 0, '0', '{}'::text[], ${text(body)},
       sha256(convert_to(${text(body)}, 'UTF8')));`,
  ];
  if (state !== 'draft') {
    rows.push(
      `insert into app.published_versions (organization_id, project_id, node_id, version_id,
         type_id, content, fields, is_current, render_policy_version, visibility)
       values ('${org}', '${project}', '${node}', '${version}', '${typeId}', '{}',
         '{"title":"${slug}"}', true, 1, '${state}');`,
      `insert into app.published_chunks (organization_id, project_id, node_id, version_id, ord,
         page_path, title, heading_path, body, body_sha256, visibility, is_current)
       values ('${org}', '${project}', '${node}', '${version}', 0, '/${slug}', '${slug}',
         '{}'::text[], ${text(body)}, sha256(convert_to(${text(body)}, 'UTF8')), '${state}', true);`,
    );
  }
  await h.sql(rows.join('\n'));
  const rebuilt = await createTermRebuild({ store: appTermStore(h.db) }).rebuildTermStats({
    organizationId: org,
    projectId: project,
  });
  if (!rebuilt.ok) throw new Error(`term rebuild failed: ${rebuilt.error}`);
  return node;
}

function client(key: string) {
  const ip = nextIp();
  const transport = new StreamableHTTPClientTransport(new URL('http://api.test/mcp'), {
    requestInit: { headers: { authorization: `Bearer ${key}` } },
    fetch: (input, init) =>
      Promise.resolve(
        app.request(input instanceof URL ? input.href : input, init, {
          incoming: { socket: { remoteAddress: ip } },
        }),
      ),
  });
  return { client: new Client({ name: 'stock', version: '0' }), transport };
}

async function connected(key: string) {
  const { client: c, transport } = client(key);
  await c.connect(transport);
  return c;
}

// The raw answer to an initialize, for refusals the client would only see as a thrown error.
async function status(key: string): Promise<{ status: number; code: unknown }> {
  const response = await app.request(
    'http://api.test/mcp',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    },
    { incoming: { socket: { remoteAddress: nextIp() } } },
  );
  const body = (await response.json()) as { error?: { code?: unknown } };
  return { status: response.status, code: body.error?.code };
}

const hitsFor = async (c: Client, query: string) => {
  const result = await c.callTool({ name: 'search_docs', arguments: { query } });
  return (result.structuredContent as { hits: { text: string }[] }).hits.map((hit) => hit.text);
};

describeWithStack('MCP over the API with real keys', () => {
  beforeAll(async () => {
    h = await fresh();
    const orgA = await h.organization();
    const orgB = await h.organization();
    const orgShut = await h.organization();
    const shut = TIERS.find((tier) => limitFor(tier, 'docs.mcp_requests_per_month') === 0);
    if (shut === undefined) throw new Error('plan table changed');
    await h.sql(`update app.organizations set plan_tier = '${shut}'
                 where organization_id = '${orgShut}';`);
    const a1 = await h.project(orgA, 'docs');
    const a2 = await h.project(orgA, 'docs');
    const studio = await h.project(orgA, 'studio');
    const b1 = await h.project(orgB, 'docs');
    const shutProject = await h.project(orgShut, 'docs');
    await page(orgA, a1, 'own', `The ${OWN} guide.`, 'public');
    await page(orgA, a1, 'secret', `Hidden ${PROTECTED}.`, 'protected');
    await page(orgA, a1, 'later', `Unpublished ${DRAFT}.`, 'draft');
    await page(orgA, a2, 'own', `Sibling ${SIBLING}.`, 'public');
    foreignNode = await page(orgB, b1, 'own', `Foreign ${FOREIGN}.`, 'public');
    await page(orgShut, shutProject, 'own', `Shut ${OWN}.`, 'public');

    const read = ['docs:pages.read'];
    keys['a1'] = await h.key(orgA, read, [a1]);
    keys['a2'] = await h.key(orgA, read, [a2]);
    keys['b1'] = await h.key(orgB, read, [b1]);
    keys['all'] = await h.key(orgA, read);
    keys['two'] = await h.key(orgA, read, [a1, a2]);
    keys['studio'] = await h.key(orgA, read, [studio]);
    keys['noScope'] = await h.key(orgA, ['studio:content.read'], [a1]);
    keys['shut'] = await h.key(orgShut, read, [shutProject]);

    const env = { ...h.env, DREFYN_AUTH_RATE_API_KEY_FAIL: '1000/1m' };
    const authConfig = parseApiAuthConfig(env);
    const failures = createApiKeyFailureLimiter({ db: h.db, config: authConfig });
    const isOn: FlagClient['isOn'] = (name) => Promise.resolve(flagsOn[name] ?? true);
    const deps: ApiDeps = {
      db: h.db,
      published: h.published,
      keys: createApiKeyVerifier(env, {
        db: h.db,
        limiter: failures,
        logger: { warn: () => undefined },
      }),
      failures,
      flags: {
        isOn,
        evaluate: () => Promise.reject(new Error('unused')),
        close: () => Promise.resolve(),
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      config: { hops: 0, viewerHeader: false, maxBodyBytes: 1_048_576 },
    };
    app = createApp(deps);
    mountMcp(app, deps, {
      retrieval: createRetrieval({
        reader: publishedReader(h.published),
        config: DEFAULT_RETRIEVAL_CONFIG,
        flags: { evaluate: () => Promise.resolve({ value: true }) },
      }),
      store: appMcpStore(h.db),
      config: { maxBodyBytes: 65_536, host: null },
    });
  });

  it('a key for one project reads that project and nothing else', async () => {
    flagsOn = {};
    const c = await connected(keys['a1'] ?? '');
    expect(await hitsFor(c, OWN)).toEqual([`The ${OWN} guide.`]);
    for (const word of WORDS.filter((w) => w !== OWN)) expect(await hitsFor(c, word)).toEqual([]);
    const foreign = await c.callTool({ name: 'get_page', arguments: { nodeId: foreignNode } });
    expect(foreign.structuredContent).toEqual({ code: 'retrieval.not_found' });
    for (const path of ['/secret', '/later']) {
      const result = await c.callTool({ name: 'get_page', arguments: { path } });
      expect(result.structuredContent).toEqual({ code: 'retrieval.not_found' });
    }
    const own = JSON.stringify(await c.callTool({ name: 'get_page', arguments: { path: '/own' } }));
    expect(own).toContain(OWN);
    await c.close();
  });

  it('the same path in another project or organization answers that key its own page', async () => {
    flagsOn = {};
    const a2 = await connected(keys['a2'] ?? '');
    expect(await hitsFor(a2, `${OWN} ${SIBLING} ${FOREIGN}`)).toEqual([`Sibling ${SIBLING}.`]);
    await a2.close();
    const b1 = await connected(keys['b1'] ?? '');
    expect(await hitsFor(b1, `${OWN} ${SIBLING} ${FOREIGN}`)).toEqual([`Foreign ${FOREIGN}.`]);
    const own = JSON.stringify(
      await b1.callTool({ name: 'get_page', arguments: { path: '/own' } }),
    );
    expect(own).toContain(FOREIGN);
    expect(own).not.toContain(OWN);
    await b1.close();
  });

  it.each(['all', 'two', 'studio', 'noScope'])(
    'a %s key is refused with 403 before any read',
    async (name) => {
      flagsOn = {};
      expect(await status(keys[name] ?? '')).toEqual({ status: 403, code: 'auth.api_key_scope' });
    },
  );

  it('an unknown key is 401', async () => {
    flagsOn = {};
    expect(await status('drf_xx_nothing')).toEqual({ status: 401, code: 'auth.api_key_invalid' });
  });

  it('a plan with a cap of 0 is 429', async () => {
    flagsOn = {};
    expect(await status(keys['shut'] ?? '')).toEqual({ status: 429, code: 'api.limit_reached' });
  });

  it('mcp.v1 off is 404 and on serves', async () => {
    flagsOn = { 'mcp.v1': false };
    expect(await status(keys['a1'] ?? '')).toEqual({ status: 404, code: 'api.not_found' });
    flagsOn = { 'mcp.v1': true };
    expect((await status(keys['a1'] ?? '')).status).toBe(200);
  });

  it('mcp.serve off is 503', async () => {
    flagsOn = { 'mcp.serve': false };
    expect(await status(keys['a1'] ?? '')).toEqual({ status: 503, code: 'api.unavailable' });
    flagsOn = {};
  });
});
