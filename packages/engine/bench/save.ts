// A whole saveDraft through the real parse host and Postgres, against the budget, split into its
// stages. Needs a stack:
//   COMPOSE_PROJECT_NAME=<stack> node bench/save.ts
// Only a run on the pinned Postgres 18 image counts, so any other server exits 1 whatever the
// times. Plain Node, not vitest bench: its module runner adds to every call and it reports no p95.
import { randomUUID } from 'node:crypto';
import { cpus, loadavg } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { closeDatabase, createDatabase, parseDatabaseConfig } from '@drefyn/db';
import { DEFAULT_LIMITS, type MdxRoot } from '@drefyn/mdx';
import { createParseClient } from '@drefyn/mdx/client';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import {
  createEngine,
  databaseStore,
  type EngineStore,
  type EngineTracer,
  type NodeId,
  type VersionId,
} from '../src/index.ts';
import { chunkForeignKeyCost } from '../test/support/foreign-keys.ts';
import setup from '../test/support/global-setup.ts';
import { superuser, urlFor } from '../test/support/stack.ts';
import { pageOf, percentile, rounded } from './support.ts';

const SAVE_BUDGET_MS = 150;
const SMALL_PAGE_BUDGET_MS = 25;
const FOREIGN_KEY_BUDGET_MS = 50;
const CHUNKS_ON_A_LARGE_PAGE = 233;
const LARGE_PAGE_BYTES = 100 * 1024;
const SMALL_PAGE_BYTES = 6 * 1024;
const WARM_UP = 30;
const SAMPLES = 120;
// Lets the garbage collector and the JIT threads settle, as a server between requests would.
const PAUSE_MS = 20;
const PARSE_BUDGET_WAITS = 30;
const PARSE_BUDGET_WAIT_MS = 5000;
// Saves rotate through this many nodes, so one node's history does not stand for the table.
const NODES_PER_CASE = 16;

const { DREFYN_BENCH_NODES: LARGEST_TENANT_NODES } = z
  .object({
    DREFYN_BENCH_NODES: z
      .string()
      .regex(/^[0-9]{3,7}$/)
      .default('200000')
      .transform(Number),
  })
  .parse(process.env);
const SECOND_TENANT_NODES = Math.floor(LARGEST_TENANT_NODES / 4);
// A long tail, as the extended statistics only matter with many tenants in the table.
const TAIL_TENANTS = 400;
const TAIL_TENANT_NODES = 50;

const provided = new Map<string, string | null>();
const teardown = await setup({
  provide: (key: string, value: string | null) => provided.set(key, value),
} as never);
if (typeof teardown !== 'function') {
  throw new Error(`no stack: ${String(provided.get('engineStackAbsent'))}`);
}
const name = provided.get('engineDatabase') ?? '';
const parseUrl = provided.get('engineParseUrl') ?? '';

interface Seeded {
  readonly organization: string;
  readonly project: string;
  readonly typeId: string;
  readonly tenant: TenantRef;
}

const tenantRow = (nodes: number): Seeded & { readonly nodes: number } => {
  const organization = randomUUID();
  const project = randomUUID();
  return {
    organization,
    project,
    typeId: randomUUID(),
    nodes,
    tenant: { organizationId: organizationId(organization), projectId: projectId(project) },
  };
};

const largest = tenantRow(LARGEST_TENANT_NODES);
const second = tenantRow(SECOND_TENANT_NODES);

// Shuffled in the heap, as saves from many tenants would leave it, and vacuumed, as autovacuum
// would have done by the time a table is this size.
const seedAll = () =>
  superuser(
    `
create temp table bench_tenants (organization uuid, project uuid, type uuid, nodes int);
insert into bench_tenants values
  ${[largest, second]
    .map((t) => `('${t.organization}', '${t.project}', '${t.typeId}', ${String(t.nodes)})`)
    .join(',\n  ')};
insert into bench_tenants
  select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), ${String(TAIL_TENANT_NODES)}
  from generate_series(1, ${String(TAIL_TENANTS)});
insert into app.organizations (organization_id, name, plan_tier)
  select organization, 'Bench', 'self_hosted' from bench_tenants;
insert into app.projects (id, organization_id, product, slug, name)
  select project, organization, 'docs', 'bench', 'Bench' from bench_tenants;
insert into app.content_types (id, organization_id, project_id, family, key)
  select type, organization, project, 'docs_page', 'page' from bench_tenants;
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle)
  select organization, project, 'docs_page', type, 'a', 'draft'
  from bench_tenants, generate_series(1, nodes)
  order by random();
insert into app.node_versions (organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256)
  select organization_id, project_id, id, 1, 1, 1, 'import', '{"kind":"system","job":"bench"}',
         '{}', sha256(id::text::bytea)
  from app.nodes order by id;
update app.nodes n set head_version_id = v.id
  from app.node_versions v where v.node_id = n.id;
insert into app.node_filter_rows (organization_id, project_id, type_id, node_id, t1, t2, t3, t4,
    t5, i1, i2, i3, i4, i5, d1, d2)
  select organization_id, project_id, type_id, id, 'alpha', 'beta', 'gamma', 'delta', 'epsilon',
         1, 2, 3, 4, 5, now(), now()
  from app.nodes;
vacuum analyze app.nodes;
vacuum analyze app.node_versions;
vacuum analyze app.node_filter_rows;
vacuum analyze app.chunks;`,
    name,
  );

const db = await createDatabase(
  parseDatabaseConfig({ DREFYN_DATABASE_URL: urlFor('app', name), DREFYN_DATABASE_SSL: 'disable' }),
);
const parse = createParseClient({ url: parseUrl });
const parsePolicy = {
  version: 1,
  components: [] as string[],
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
} as const;

// The budget covers filter rows, and the save does not write them until queryNodes lands. So the
// bench adds that write itself, in the same transaction, with every slot changing, which is the
// costly case: a save that changes no slot will skip it.
let saving: { readonly seeded: Seeded; readonly nodeId: NodeId; readonly round: number } | null =
  null;
const real = databaseStore(db);
const store: EngineStore = {
  tenant: (tenant, work) =>
    real.tenant(tenant, async (tx) => {
      const answer = await work(tx);
      if (saving !== null) {
        const { seeded, nodeId, round } = saving;
        const text = String(round);
        await tx
          .updateTable('node_filter_rows')
          .set({ t1: text, t2: text, t3: text, t4: text, t5: text })
          .set({ i1: round, i2: round, i3: round, i4: round, i5: round })
          .set({ d1: new Date(), d2: new Date() })
          .where('organization_id', '=', seeded.tenant.organizationId)
          .where('project_id', '=', seeded.tenant.projectId)
          .where('type_id', '=', seeded.typeId)
          .where('node_id', '=', nodeId)
          .executeTakeFirstOrThrow();
      }
      return answer;
    }),
};

// One sample's time in each stage, read off the spans the engine opens in production.
let stages = new Map<string, number>();
const tracer: EngineTracer = {
  span: async (spanName, _fields, work) => {
    const started = performance.now();
    try {
      return await work();
    } finally {
      stages.set(spanName, performance.now() - started);
    }
  },
};

const engine = createEngine({
  store,
  parse,
  parsePolicy,
  tracer,
  flags: { evaluate: () => Promise.resolve({ value: true }) },
});

async function treeOf(tenant: TenantRef, source: string): Promise<MdxRoot> {
  const answer = await parse.parse({
    tenant,
    path: 'bench',
    source,
    dialect: 'md',
    policy: { ...parsePolicy, components: new Set(), limits: DEFAULT_LIMITS },
  });
  if (!answer.ok) throw new Error(`refused: ${answer.error.map((e) => e.code).join(' ')}`);
  return answer.value.ast;
}

interface Target {
  readonly node: NodeId;
  readonly version: VersionId;
}

const headRow = z.object({ node: z.string(), version: z.string() });

async function endOfTable(seeded: Seeded, order: 'asc' | 'desc'): Promise<readonly Target[]> {
  const text = await superuser(
    `select coalesce(json_agg(json_build_object('node', id, 'version', head_version_id)), '[]')
     from (select id, head_version_id from app.nodes where project_id = '${seeded.project}'
           order by id ${order} limit ${String(NODES_PER_CASE)}) ends;`,
    name,
  );
  return z
    .array(headRow)
    .parse(JSON.parse(text))
    .map(({ node, version }) => ({ node: node as NodeId, version: version as VersionId }));
}

interface Page {
  readonly source: string;
  readonly content: MdxRoot;
}

const summary = (values: readonly number[]) => ({
  p50_ms: rounded(percentile(values, 0.5)),
  p95_ms: rounded(percentile(values, 0.95)),
});

async function run(
  label: string,
  seeded: Seeded,
  order: 'asc' | 'desc',
  { source, content }: Page,
  budgetMs: number,
): Promise<boolean> {
  const heads = new Map<NodeId, VersionId>();
  const targets = await endOfTable(seeded, order);
  for (const { node, version } of targets) heads.set(node, version);
  const samples: number[] = [];
  const staged = new Map<string, number[]>();
  for (let round = 0; round < WARM_UP + SAMPLES; round += 1) {
    const target = targets[round % targets.length];
    if (target === undefined) throw new Error('no nodes');
    saving = { seeded, nodeId: target.node, round };
    const input = {
      tenant: seeded.tenant,
      nodeId: target.node,
      expectedHeadVersionId: heads.get(target.node) ?? null,
      content,
      origin: 'human',
      actor: { kind: 'system', job: 'bench' },
      idempotencyKey: randomUUID(),
    } as const;
    let elapsed = 0;
    let saved = null;
    // One project passes the parse budget of 20 s a minute. A refusal stored nothing and is not
    // a sample, so wait the budget out rather than time it.
    for (let attempt = 0; attempt < PARSE_BUDGET_WAITS; attempt += 1) {
      stages = new Map();
      const started = performance.now();
      saved = await engine.saveDraft(input);
      elapsed = performance.now() - started;
      if (saved.ok || saved.error.code !== 'engine.unavailable') break;
      await pause(PARSE_BUDGET_WAIT_MS);
    }
    saving = null;
    if (!saved?.ok) throw new Error(saved?.error.code ?? 'no attempt ran');
    heads.set(target.node, saved.value.versionId);
    if (round >= WARM_UP) {
      samples.push(elapsed);
      for (const [stage, ms] of stages) {
        staged.set(stage, [...(staged.get(stage) ?? []), ms]);
      }
    }
    await pause(PAUSE_MS);
  }
  const p95 = percentile(samples, 0.95);
  const line = {
    case: label,
    source_bytes: Buffer.byteLength(source),
    stored_bytes: Buffer.byteLength(JSON.stringify(content)),
    samples: samples.length,
    p50_ms: rounded(percentile(samples, 0.5)),
    p95_ms: rounded(p95),
    p99_ms: rounded(percentile(samples, 0.99)),
    budget_ms: budgetMs,
    print: summary(staged.get('engine.save.verify') ?? []),
    chunk: summary(staged.get('engine.save.chunk') ?? []),
    database: summary(staged.get('engine.save.write') ?? []),
    load: rounded(loadavg()[0] ?? 0),
    cores: cpus().length,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  return p95 < budgetMs;
}

async function foreignKeys(label: string, seeded: Seeded, order: 'asc' | 'desc') {
  const [target] = await endOfTable(seeded, order);
  if (target === undefined) throw new Error('no nodes');
  const { checks, ms } = await chunkForeignKeyCost(
    (text) => superuser(text, name),
    {
      organization: seeded.organization,
      project: seeded.project,
      node: target.node,
      version: target.version,
    },
    CHUNKS_ON_A_LARGE_PAGE,
  );
  const line = {
    case: label,
    chunks: CHUNKS_ON_A_LARGE_PAGE,
    checks,
    foreign_key_ms: rounded(ms),
    budget_ms: FOREIGN_KEY_BUDGET_MS,
  };
  process.stdout.write(`${JSON.stringify(line)}\n`);
  return checks > 0 && ms < FOREIGN_KEY_BUDGET_MS;
}

process.exitCode = 1;
try {
  const version = await superuser(`show server_version;`, name);
  const pinned = version.startsWith('18.');
  process.stdout.write(
    `${JSON.stringify({
      postgres: version,
      pinned,
      largest_tenant_nodes: LARGEST_TENANT_NODES,
      filter_rows: 'written by the bench',
    })}\n`,
  );
  await seedAll();
  const pageAt = async (bytes: number): Promise<Page> => {
    const source = pageOf(bytes);
    return { source, content: await treeOf(largest.tenant, source) };
  };
  const large = await pageAt(LARGE_PAGE_BYTES);
  const small = await pageAt(SMALL_PAGE_BYTES);
  const outcomes = [
    pinned,
    await foreignKeys('foreign keys, largest, newest', largest, 'desc'),
    await foreignKeys('foreign keys, largest, oldest', largest, 'asc'),
    await foreignKeys('foreign keys, second, newest', second, 'desc'),
    await foreignKeys('foreign keys, second, oldest', second, 'asc'),
    await run('save 100 KB, largest, newest', largest, 'desc', large, SAVE_BUDGET_MS),
    await run('save 100 KB, largest, oldest', largest, 'asc', large, SAVE_BUDGET_MS),
    await run('save 100 KB, second, newest', second, 'desc', large, SAVE_BUDGET_MS),
    await run('save 100 KB, second, oldest', second, 'asc', large, SAVE_BUDGET_MS),
    await run('save 6 KB, largest, newest', largest, 'desc', small, SMALL_PAGE_BUDGET_MS),
  ];
  if (outcomes.every(Boolean)) process.exitCode = 0;
} finally {
  await closeDatabase(db);
  await teardown();
}
