// What the chunk copy, postings and term statistics add to publishing a 100 KB page, against
// the budget: p95 under 1,000 ms, timed around writePublishedChunks inside the publish
// transaction, with the published_versions write timed beside it as the baseline. The project
// already holds published pages, so the statistics upserts mostly hit existing lexemes. Needs a
// stack:
//   COMPOSE_PROJECT_NAME=<stack> node bench/publish.ts
// Only a run on the pinned Postgres 18 image counts, so any other server exits 1 whatever the
// times. Runs above load 10 are void and say so.
import { randomUUID } from 'node:crypto';
import { cpus, loadavg } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { closeDatabase, createDatabase, parseDatabaseConfig, withTenant } from '@drefyn/db';
import { DEFAULT_LIMITS } from '@drefyn/mdx';
import { createParseClient } from '@drefyn/mdx/client';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { chunkNode, DEFAULT_ENGINE_CONFIG } from '../src/index.ts';
import { writePublishedChunks } from '../src/published-chunks.ts';
import setup from '../test/support/global-setup.ts';
import { parseClientConfig } from '../test/support/parse-host.ts';
import { superuser, urlFor } from '../test/support/stack.ts';
import { pageOf, percentile, rounded } from './support.ts';

const P95_MS = 1000;
const VOID_LOAD = 10;
const PAGE_BYTES = 100 * 1024;
// Pages already public in the project before the timed publishes start.
const PUBLISHED_BEFORE = 40;
const WARM_UP = 5;
const SAMPLES = 40;
const PAUSE_MS = 20;

const provided = new Map<string, string | null>();
const teardown = await setup({
  provide: (key: string, value: string | null) => provided.set(key, value),
} as never);
if (typeof teardown !== 'function') {
  throw new Error(`no stack: ${String(provided.get('engineStackAbsent'))}`);
}
const name = provided.get('engineDatabase') ?? '';
const parseUrl = provided.get('engineParseUrl') ?? '';

const organization = randomUUID();
const project = randomUUID();
const typeId = randomUUID();
const tenant: TenantRef = {
  organizationId: organizationId(organization),
  projectId: projectId(project),
};
const NODES = PUBLISHED_BEFORE + WARM_UP + SAMPLES;
const nodeIds = Array.from({ length: NODES }, () => randomUUID());
const versionIds = Array.from({ length: NODES }, () => randomUUID());

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

// The page is chunked by the engine's own chunker, so row count and sizes are what a save of
// it stores. Every node gets the same chunks plus a word of its own, so its lexeme set is not
// exactly another's.
async function seedAll(): Promise<number> {
  const parse = createParseClient(parseClientConfig(parseUrl));
  const answer = await parse.parse({
    tenant,
    path: 'bench',
    source: pageOf(PAGE_BYTES),
    dialect: 'md',
    policy: {
      version: 1,
      components: new Set(),
      rawHtml: 'sanitize',
      remoteImages: 'proxy',
      linkProtocols: ['https', 'http', 'mailto'],
      limits: DEFAULT_LIMITS,
    },
  });
  if (!answer.ok) throw new Error(`refused: ${answer.error.map((e) => e.code).join(' ')}`);
  const chunks = chunkNode(answer.value.ast, {
    targetChars: DEFAULT_ENGINE_CONFIG.chunkTargetChars,
    maxChars: DEFAULT_ENGINE_CONFIG.chunkMaxChars,
  });
  const template = chunks
    .map(
      (chunk) =>
        `(${String(chunk.ord)}, array[${chunk.headingPath.map(quote).join(', ')}]::text[], ${quote(chunk.body)})`,
    )
    .join(',\n');
  await superuser(
    `
insert into app.organizations (organization_id, name, plan_tier)
  values ('${organization}', 'Bench', 'self_hosted');
insert into app.projects (id, organization_id, product, slug, name)
  values ('${project}', '${organization}', 'docs', 'bench', 'Bench');
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${typeId}', '${organization}', '${project}', 'docs_page', 'page');
create temp table bench_nodes (at int, node uuid, version uuid);
insert into bench_nodes values
  ${nodeIds.map((id, at) => `(${String(at)}, '${id}', '${versionIds[at] ?? ''}')`).join(',\n  ')};
create temp table bench_chunks (ord int, heading_path text[], body text);
insert into bench_chunks values ${template};
insert into app.nodes (id, organization_id, project_id, family, type_id, slug, order_key,
    lifecycle)
  select node, '${organization}', '${project}', 'docs_page', '${typeId}', 'page-' || at, 'a' || at,
         'draft'
    from bench_nodes;
insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256)
  select version, '${organization}', '${project}', node, 1, 1, 1, 'import',
         '{"kind":"system","job":"bench"}', '{}', sha256(version::text::bytea)
    from bench_nodes;
insert into app.chunks (organization_id, project_id, node_id, version_id, ord, block_path,
    heading_path, body, body_sha256)
  select '${organization}', '${project}', n.node, n.version, c.ord, c.ord::text, c.heading_path,
         c.body || ' page' || n.at, sha256(convert_to(c.body || ' page' || n.at, 'UTF8'))
    from bench_nodes n cross join bench_chunks c;
vacuum analyze app.chunks;`,
    name,
  );
  return chunks.length;
}

const db = await createDatabase(
  parseDatabaseConfig({ DREFYN_DATABASE_URL: urlFor('app', name), DREFYN_DATABASE_SSL: 'disable' }),
);

interface Sample {
  readonly versionMs: number;
  readonly copyMs: number;
  readonly postings: number;
}

// One publish transaction: the version row as publish writes it, then the copy.
function publishOne(at: number): Promise<Sample> {
  const nodeId = nodeIds[at] ?? '';
  const versionId = versionIds[at] ?? '';
  return withTenant(db, tenant, async (tx) => {
    const started = performance.now();
    await sql`
      insert into app.published_versions (organization_id, project_id, node_id, version_id,
          type_id, content, fields, is_current, render_policy_version)
      select v.organization_id, v.project_id, v.node_id, v.id, ${typeId}::uuid, v.content,
             v.fields, true, 1
        from app.node_versions v
       where v.organization_id = ${tenant.organizationId}::uuid
         and v.project_id = ${tenant.projectId}::uuid and v.id = ${versionId}::uuid`.execute(tx);
    const versioned = performance.now();
    const copy = await writePublishedChunks(tx, tenant, nodeId, {
      versionId,
      visibility: 'public',
    });
    return {
      versionMs: versioned - started,
      copyMs: performance.now() - versioned,
      postings: copy.postingsAdded,
    };
  });
}

const write = (line: object) => {
  process.stdout.write(`${JSON.stringify({ ...line, load: rounded(loadavg()[0] ?? 0) })}\n`);
};

async function run(): Promise<boolean> {
  let at = 0;
  for (; at < PUBLISHED_BEFORE + WARM_UP; at += 1) await publishOne(at);
  const samples: Sample[] = [];
  let maxLoad = 0;
  for (; at < NODES; at += 1) {
    samples.push(await publishOne(at));
    maxLoad = Math.max(maxLoad, loadavg()[0] ?? 0);
    await pause(PAUSE_MS);
  }
  const copy = samples.map((s) => s.copyMs);
  const p95 = percentile(copy, 0.95);
  write({
    case: 'publish 100 KB page',
    samples: samples.length,
    postings_per_page: samples[0]?.postings ?? 0,
    version_row_p50_ms: rounded(
      percentile(
        samples.map((s) => s.versionMs),
        0.5,
      ),
    ),
    version_row_p95_ms: rounded(
      percentile(
        samples.map((s) => s.versionMs),
        0.95,
      ),
    ),
    copy_p50_ms: rounded(percentile(copy, 0.5)),
    copy_p95_ms: rounded(p95),
    copy_max_ms: rounded(Math.max(...copy)),
    budget_ms: P95_MS,
    max_load: rounded(maxLoad),
    void: maxLoad > VOID_LOAD,
  });
  return p95 < P95_MS && maxLoad <= VOID_LOAD;
}

process.exitCode = 1;
try {
  const version = await superuser(`show server_version;`, name);
  const pinned = version.trim().startsWith('18.');
  write({ postgres: version.trim(), pinned, cores: cpus().length });
  const chunks = await seedAll();
  write({ chunks_per_page: chunks, page_bytes: PAGE_BYTES });
  if (pinned && (await run())) process.exitCode = 0;
} finally {
  await closeDatabase(db);
  await teardown();
}
