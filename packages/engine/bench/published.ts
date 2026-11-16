// listPublished against the budget: a filtered, sorted public list on 200,000 published items
// has p95 under 50 ms for every shape, read as drefyn_public_reader. Needs a stack:
//   COMPOSE_PROJECT_NAME=<stack> node bench/published.ts
// Only a run on the pinned Postgres 18 image counts, so any other server exits 1 whatever the
// times. Runs above load 10 are void and say so.
import { randomUUID } from 'node:crypto';
import { cpus, loadavg } from 'node:os';
import {
  closeDatabase,
  createDatabase,
  createPublishedDatabase,
  parseDatabaseConfig,
  parsePublishedReaderConfig,
} from '@drefyn/db';
import type { FilterNode } from '@drefyn/schema';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import {
  cachedTypes,
  createPublishedReader,
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  publishedStore,
  storeTypes,
  type PublishedQuery,
} from '../src/index.ts';
import setup from '../test/support/global-setup.ts';
import { superuser, urlFor } from '../test/support/stack.ts';
import { benchFields, benchSchema, percentile, rounded } from './support.ts';

const P95_MS = 50;
const VOID_LOAD = 10;
const SAMPLES_PER_SET = 30;
const WARM_UP_ROUNDS = 5;
const LIST_LIMIT = 20;
const TAIL_TENANTS = 2000;

const env = z
  .object({
    DREFYN_BENCH_NODES: z
      .string()
      .regex(/^[0-9]{3,7}$/)
      .default('200000')
      .transform(Number),
    // Items in each of the 2,000 small tenants. The large tenant's share of the table decides
    // its plan: a scan of the whole table when it holds most of it, an index only scan of its
    // own range when it does not.
    DREFYN_BENCH_TAIL_ITEMS: z
      .string()
      .regex(/^[0-9]{1,5}$/)
      .default('50')
      .transform(Number),
  })
  .parse(process.env);
const ITEMS = env.DREFYN_BENCH_NODES;
const TAIL_ITEMS = env.DREFYN_BENCH_TAIL_ITEMS;

const provided = new Map<string, string | null>();
const teardown = await setup({
  provide: (key: string, value: string | null) => provided.set(key, value),
} as never);
if (typeof teardown !== 'function') {
  throw new Error(`no stack: ${String(provided.get('engineStackAbsent'))}`);
}
const name = provided.get('engineDatabase') ?? '';

const organization = randomUUID();
const project = randomUUID();
const typeId = randomUUID();
const fields = benchFields();
const tenant: TenantRef = {
  organizationId: organizationId(organization),
  projectId: projectId(project),
};
const { schema, slots } = benchSchema(typeId, fields);
const slot = (field: { readonly id: string }) => slots[field.id]?.column ?? '';

// Every item published once and current, shuffled in the heap as many tenants' publishes leave
// it, then vacuumed as a quiet table would be.
const seedAll = async () => {
  await superuser(
    `
create temp table bench_tenants (organization uuid, project uuid, type uuid, nodes int);
insert into bench_tenants values ('${organization}', '${project}', '${typeId}', ${String(ITEMS)});
insert into bench_tenants
  select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), ${String(TAIL_ITEMS)}
  from generate_series(1, ${String(TAIL_TENANTS)});
insert into app.organizations (organization_id, name, plan_tier)
  select organization, 'Bench', 'self_hosted' from bench_tenants;
insert into app.projects (id, organization_id, product, slug, name)
  select project, organization, 'studio', 'bench', 'Bench' from bench_tenants;
insert into app.content_types (id, organization_id, project_id, family, key)
  select type, organization, project, 'studio_item', 'item' from bench_tenants;
update app.content_types
  set content_schema = '${JSON.stringify(schema)}', filter_slots = '${JSON.stringify(slots)}'
  where id = '${typeId}';
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle)
  select organization, project, 'studio_item', type, 'a', 'published'
  from bench_tenants, generate_series(1, nodes) g
  order by random();
insert into app.node_versions (organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256)
  select organization_id, project_id, id, 1, 1, 1, 'import', '{"kind":"system","job":"bench"}',
         '{}', sha256(id::text::bytea)
  from app.nodes;
insert into app.published_versions (organization_id, project_id, node_id, version_id, type_id,
    content, is_current, render_policy_version, visibility)
  select v.organization_id, v.project_id, v.node_id, v.id, n.type_id,
         '{"type":"root","children":[]}', true, 1, 'public'
  from app.node_versions v join app.nodes n on n.id = v.node_id
  order by random();
insert into app.published_filter_rows (organization_id, project_id, type_id, node_id, visibility,
    ${slot(fields.category)}, ${slot(fields.status)}, ${slot(fields.segment)}, ${slot(fields.title)},
    ${slot(fields.tags)}, ${slot(fields.score)}, ${slot(fields.rank)}, ${slot(fields.size)},
    ${slot(fields.weight)}, ${slot(fields.region)}, ${slot(fields.created)}, ${slot(fields.updated)})
  select organization_id, project_id, type_id, id, 'public',
         'category ' || (random() * 9)::int,
         (array['active','active','active','active','held'])[1 + (random() * 4)::int],
         'segment ' || (random() * 999)::int,
         'a title of about thirty bytes ' || (random() * 99999)::int,
         array['tag ' || (random() * 9)::int, 'tag ' || (random() * 99)::int],
         (random() * 1000)::bigint, (random() * 100000)::bigint, (random() * 10)::bigint,
         (random() * 1000000)::bigint, (random() * 5)::bigint,
         now() - random() * interval '700 days', now() - random() * interval '30 days'
  from app.nodes where type_id = '${typeId}';
insert into app.published_filter_rows (organization_id, project_id, type_id, node_id, visibility)
  select organization_id, project_id, type_id, id, 'public' from app.nodes
   where type_id <> '${typeId}';
vacuum analyze app.published_versions;
vacuum analyze app.published_filter_rows;`,
    name,
  );
};

const app = await createDatabase(
  parseDatabaseConfig({ DREFYN_DATABASE_URL: urlFor('app', name), DREFYN_DATABASE_SSL: 'disable' }),
);
const readerDb = await createPublishedDatabase(
  parsePublishedReaderConfig({
    DREFYN_PUBLIC_READER_DATABASE_URL: urlFor('reader', name),
    DREFYN_DATABASE_SSL: 'disable',
  }),
);
const reader = createPublishedReader({
  store: publishedStore(readerDb),
  // As a host runs it: definitions cached, so a list is one reader transaction.
  types: cachedTypes(storeTypes(databaseStore(app, DEFAULT_ENGINE_CONFIG))),
});

type Query = Pick<PublishedQuery, 'filter' | 'sort'>;
const leaf = (field: { readonly id: string }, op: string, value?: unknown) =>
  ({ field: field.id, op, ...(value === undefined ? {} : { value }) }) as FilterNode;
const range = (count: number) => Array.from({ length: count }, (_, at) => at);
const newest = { field: fields.created.id, direction: 'desc' } as const;

const SHAPES: readonly { readonly name: string; readonly sets: readonly Query[] }[] = [
  { name: 'sorted, no filter', sets: [{ sort: newest }] },
  { name: 'broad, newest', sets: [{ filter: leaf(fields.status, 'eq', 'active'), sort: newest }] },
  {
    name: 'category, newest',
    sets: range(6).map((at) => ({
      filter: leaf(fields.category, 'eq', `category ${String(at)}`),
      sort: newest,
    })),
  },
  {
    name: 'rare segment, by score',
    sets: range(6).map((at) => ({
      filter: leaf(fields.segment, 'eq', `segment ${String(at * 37)}`),
      sort: { field: fields.score.id, direction: 'desc' },
    })),
  },
  {
    name: 'category and range, by title',
    sets: range(4).map((at) => ({
      filter: {
        and: [
          leaf(fields.category, 'eq', `category ${String(at)}`),
          leaf(fields.score, 'gte', '500'),
        ],
      },
      sort: { field: fields.title.id, direction: 'asc' },
    })),
  },
  {
    name: 'tag, newest',
    sets: range(4).map((at) => ({
      filter: leaf(fields.tags, 'eq', `tag ${String(at)}`),
      sort: newest,
    })),
  },
  {
    name: 'matching nothing, newest',
    sets: range(4).map((at) => ({
      filter: leaf(fields.segment, 'eq', `none ${String(at)}`),
      sort: newest,
    })),
  },
];

async function timed(query: Query): Promise<number> {
  const started = performance.now();
  const page = await reader.listPublished(tenant, { typeId, limit: LIST_LIMIT, ...query });
  const elapsed = performance.now() - started;
  if (!page.ok) throw new Error(`list refused: ${JSON.stringify(page.error)}`);
  return elapsed;
}

const write = (line: object) => {
  process.stdout.write(`${JSON.stringify({ ...line, load: rounded(loadavg()[0] ?? 0) })}\n`);
};

async function run(): Promise<boolean> {
  let passed = true;
  let maxLoad = 0;
  for (let round = 0; round < WARM_UP_ROUNDS; round += 1) {
    for (const shape of SHAPES) for (const query of shape.sets) await timed(query);
  }
  const all: number[] = [];
  for (const shape of SHAPES) {
    const samples: number[] = [];
    for (const query of shape.sets) {
      for (let at = 0; at < SAMPLES_PER_SET; at += 1) samples.push(await timed(query));
      maxLoad = Math.max(maxLoad, loadavg()[0] ?? 0);
    }
    all.push(...samples);
    const p95 = percentile(samples, 0.95);
    if (p95 >= P95_MS) passed = false;
    write({
      shape: shape.name,
      sets: shape.sets.length,
      samples: samples.length,
      p50_ms: rounded(percentile(samples, 0.5)),
      p95_ms: rounded(p95),
      budget_ms: P95_MS,
    });
  }
  write({
    shape: 'all',
    samples: all.length,
    p50_ms: rounded(percentile(all, 0.5)),
    p95_ms: rounded(percentile(all, 0.95)),
    p99_ms: rounded(percentile(all, 0.99)),
    max_load: rounded(maxLoad),
    void: maxLoad > VOID_LOAD,
  });
  return passed && maxLoad <= VOID_LOAD;
}

process.exitCode = 1;
try {
  const version = await superuser(`show server_version;`, name);
  const pinned = version.trim().startsWith('18.');
  write({
    postgres: version.trim(),
    pinned,
    items: ITEMS,
    tail_items: TAIL_TENANTS * TAIL_ITEMS,
    cores: cpus().length,
  });
  const seeded = performance.now();
  await seedAll();
  write({ seeded_s: rounded((performance.now() - seeded) / 1000) });
  if (pinned && (await run())) process.exitCode = 0;
} finally {
  await closeDatabase(readerDb);
  await closeDatabase(app);
  await teardown();
}
