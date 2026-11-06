// queryNodes against the budget: declared lists p95 under 100 ms per shape and p99 under 250 ms
// with writes running, contains p95 under 200 ms, every parameter set p95 under 150 ms with no
// writes, and undeclared scans p95 under 50 ms at the 20,000 item limit. Needs a stack:
//   COMPOSE_PROJECT_NAME=<stack> node bench/query.ts
// Only a run on the pinned Postgres 18 image counts, so any other server exits 1 whatever the
// times. Runs above load 10 are void and say so.
import { randomUUID } from 'node:crypto';
import { cpus, loadavg } from 'node:os';
import { setTimeout as pause } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { closeDatabase, createDatabase, parseDatabaseConfig } from '@drefyn/db';
import { DEFAULT_LIMITS, type MdxRoot } from '@drefyn/mdx';
import { createParseClient } from '@drefyn/mdx/client';
import type { FilterNode } from '@drefyn/schema';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { z } from 'zod';
import { createEngine, databaseStore, type EngineDeps, type NodeQuery } from '../src/index.ts';
import setup from '../test/support/global-setup.ts';
import { parseClientConfig } from '../test/support/parse-host.ts';
import { superuser, urlFor } from '../test/support/stack.ts';
import type { WriterInput } from './query-writer.ts';
import { benchFields, benchSchema, pageOf, percentile, rounded } from './support.ts';

const DECLARED_P95_MS = 100;
const OVERALL_P99_MS = 250;
const CONTAINS_P95_MS = 200;
const PARAMETER_SET_P95_MS = 150;
const UNDECLARED_P95_MS = 50;
const SAVES_PER_SECOND = 50;
const SLOT_CHANGE_SHARE = 0.2;
const LISTS_PER_SECOND = 8;
const VOID_LOAD = 10;
const STATIC_SAMPLES_PER_SET = 30;
const SCAN_SAMPLES = 120;
const WARM_UP_ROUNDS = 5;
const LIST_LIMIT = 20;
const TAIL_TENANTS = 2000;
const TAIL_ITEMS = 50;
const SCAN_ITEMS = 20_000;

const env = z
  .object({
    DREFYN_BENCH_NODES: z
      .string()
      .regex(/^[0-9]{3,7}$/)
      .default('200000')
      .transform(Number),
    DREFYN_BENCH_SECONDS: z
      .string()
      .regex(/^[0-9]{1,4}$/)
      .default('360')
      .transform(Number),
  })
  .parse(process.env);
const ITEMS = env.DREFYN_BENCH_NODES;

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
const scanProject = randomUUID();
const scanOrganization = randomUUID();
const scanType = randomUUID();
const fields = benchFields();
const scanField = randomUUID();
const tenant: TenantRef = {
  organizationId: organizationId(organization),
  projectId: projectId(project),
};
const scanTenant: TenantRef = {
  organizationId: organizationId(scanOrganization),
  projectId: projectId(scanProject),
};
const { schema, slots } = benchSchema(typeId, fields);
const scanSchema = {
  ...benchSchema(scanType, fields).schema,
  fields: [
    { id: scanField, apiName: 'note', label: 'note', required: false, kind: 'text', maxLength: 64 },
  ],
};

const CATEGORIES = 10;
const SEGMENTS = 1000;
const STATUSES = [
  'active',
  'active',
  'active',
  'active',
  'active',
  'active',
  'active',
  'active',
  'active',
  'held',
];

// Shuffled in the heap, as saves from many tenants leave it, then vacuumed and rebuilt as the
// import job does.
const seedAll = async () => {
  const slot = (field: { readonly id: string }) => slots[field.id]?.column ?? '';
  await superuser(
    `
create temp table bench_tenants (organization uuid, project uuid, type uuid, nodes int);
insert into bench_tenants values
  ('${organization}', '${project}', '${typeId}', ${String(ITEMS)}),
  ('${scanOrganization}', '${scanProject}', '${scanType}', ${String(SCAN_ITEMS)});
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
update app.content_types set content_schema = '${JSON.stringify(scanSchema)}'
  where id = '${scanType}';
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle,
    head_fields)
  select organization, project, 'studio_item', type, 'a', 'draft',
         case when type = '${scanType}'
           then jsonb_build_object('${scanField}', 'note ' || (g % 500))
           else '{}'::jsonb end
  from bench_tenants, generate_series(1, nodes) g
  order by random();
insert into app.node_versions (organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256)
  select organization_id, project_id, id, 1, 1, 1, 'import', '{"kind":"system","job":"bench"}',
         '{}', sha256(id::text::bytea)
  from app.nodes order by id;
update app.nodes n set head_version_id = v.id from app.node_versions v where v.node_id = n.id;
insert into app.node_filter_rows (organization_id, project_id, type_id, node_id,
    ${slot(fields.category)}, ${slot(fields.status)}, ${slot(fields.segment)}, ${slot(fields.title)},
    ${slot(fields.tags)}, ${slot(fields.score)}, ${slot(fields.rank)}, ${slot(fields.size)},
    ${slot(fields.weight)}, ${slot(fields.region)}, ${slot(fields.created)}, ${slot(fields.updated)})
  select organization_id, project_id, type_id, id,
         'category ' || (random() * ${String(CATEGORIES - 1)})::int,
         (array['${STATUSES.join("','")}'])[1 + (random() * ${String(STATUSES.length - 1)})::int],
         'segment ' || (random() * ${String(SEGMENTS - 1)})::int,
         'a title of about thirty bytes ' || (random() * 99999)::int,
         array['tag ' || (random() * 9)::int, 'tag ' || (random() * 99)::int,
               'tag ' || (random() * 999)::int],
         (random() * 1000)::bigint, (random() * 100000)::bigint, (random() * 10)::bigint,
         (random() * 1000000)::bigint, (random() * 5)::bigint,
         now() - random() * interval '700 days', now() - random() * interval '30 days'
  from app.nodes where type_id = '${typeId}';
insert into app.node_filter_rows (organization_id, project_id, type_id, node_id)
  select organization_id, project_id, type_id, id from app.nodes where type_id <> '${typeId}';
vacuum analyze app.nodes;
vacuum analyze app.node_versions;
vacuum analyze app.node_filter_rows;
vacuum analyze app.content_types;
reindex index app.node_filter_rows_pkey;`,
    name,
  );
};

const db = await createDatabase(
  parseDatabaseConfig({ DREFYN_DATABASE_URL: urlFor('app', name), DREFYN_DATABASE_SSL: 'disable' }),
);
const parse = createParseClient(parseClientConfig(parseUrl));
const parsePolicy: EngineDeps['parsePolicy'] = {
  version: 1,
  components: [],
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
};
const engine = createEngine({
  store: databaseStore(db),
  parse,
  parsePolicy,
  flags: { evaluate: () => Promise.resolve({ value: true }) },
});

async function treeOf(source: string): Promise<MdxRoot> {
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

type Query = Pick<NodeQuery, 'filter' | 'sort'>;

interface Shape {
  readonly name: string;
  readonly contains?: true;
  // One query per parameter set. A plan can be fine for one value and poor for the next.
  readonly sets: readonly Query[];
}

const leaf = (field: { readonly id: string }, op: string, value?: unknown) =>
  ({ field: field.id, op, ...(value === undefined ? {} : { value }) }) as FilterNode;

const range = (count: number) => Array.from({ length: count }, (_, at) => at);
const newest = { field: fields.created.id, direction: 'desc' } as const;
const sets = (
  count: number,
  filter: (at: number) => FilterNode,
  sort = newest as NodeQuery['sort'],
) =>
  range(count).map((at): Query => ({
    filter: filter(at),
    ...(sort === undefined ? {} : { sort }),
  }));

const SHAPES: readonly Shape[] = [
  { name: 'no filter', sets: [{ sort: newest }] },
  { name: 'one broad', sets: sets(1, () => leaf(fields.status, 'eq', 'active')) },
  {
    name: 'one rare',
    sets: sets(8, (at) => leaf(fields.segment, 'eq', `segment ${String(at * 37)}`)),
  },
  {
    name: 'one category',
    sets: sets(8, (at) => leaf(fields.category, 'eq', `category ${String(at)}`)),
  },
  {
    name: 'matching nothing',
    sets: sets(4, (at) => leaf(fields.segment, 'eq', `none ${String(at)}`)),
  },
  {
    name: 'category and range',
    sets: sets(6, (at) => ({
      and: [
        leaf(fields.category, 'eq', `category ${String(at)}`),
        leaf(fields.score, 'gte', '500'),
      ],
    })),
  },
  {
    name: 'three mid',
    sets: sets(6, (at) => ({
      and: [
        leaf(fields.category, 'eq', `category ${String(at)}`),
        leaf(fields.size, 'lte', '5'),
        leaf(fields.score, 'gt', '250'),
      ],
    })),
  },
  {
    name: 'three broad',
    sets: sets(4, (at) => ({
      and: [
        leaf(fields.status, 'eq', 'active'),
        leaf(fields.score, 'gt', String(at * 10)),
        leaf(fields.size, 'gte', '1'),
      ],
    })),
  },
  {
    name: 'two broad, tiny result',
    sets: sets(4, (at) => ({
      and: [leaf(fields.status, 'eq', 'held'), leaf(fields.weight, 'lt', String(40 + at))],
    })),
  },
  {
    name: 'two, empty',
    sets: sets(4, (at) => ({
      and: [leaf(fields.status, 'eq', 'held'), leaf(fields.region, 'gt', String(100 + at))],
    })),
  },
  {
    name: 'in five values',
    sets: sets(6, (at) =>
      leaf(
        fields.segment,
        'in',
        range(5).map((n) => `segment ${String(at * 100 + n)}`),
      ),
    ),
  },
  { name: 'neq', sets: sets(1, () => leaf(fields.status, 'neq', 'held')) },
  {
    name: 'or across two fields, empty',
    sets: sets(4, (at) => ({
      or: [leaf(fields.segment, 'eq', `none ${String(at)}`), leaf(fields.region, 'gt', '100')],
    })),
  },
  {
    name: 'sort by integer',
    sets: sets(4, (at) => leaf(fields.category, 'eq', `category ${String(at)}`), {
      field: fields.score.id,
      direction: 'desc',
    }),
  },
  { name: 'sort by text', sets: [{ sort: { field: fields.title.id, direction: 'asc' } }] },
  { name: 'list, one value', sets: sets(6, (at) => leaf(fields.tags, 'eq', `tag ${String(at)}`)) },
  {
    name: 'contains',
    contains: true,
    sets: sets(4, (at) => leaf(fields.title, 'contains', `bytes ${String(at + 1)}`)),
  },
];

async function timed(query: Query): Promise<number> {
  const started = performance.now();
  const page = await engine.queryNodes(tenant, { typeId, limit: LIST_LIMIT, ...query });
  const elapsed = performance.now() - started;
  if (!page.ok) throw new Error(`list refused: ${JSON.stringify(page.error)}`);
  return elapsed;
}

const write = (line: object) => {
  process.stdout.write(`${JSON.stringify({ ...line, load: rounded(loadavg()[0] ?? 0) })}\n`);
};

async function staticRun(): Promise<boolean> {
  let passed = true;
  for (let round = 0; round < WARM_UP_ROUNDS; round += 1) {
    for (const shape of SHAPES) for (const query of shape.sets) await timed(query);
  }
  for (const shape of SHAPES) {
    const all: number[] = [];
    let worstSet = 0;
    for (const query of shape.sets) {
      const samples: number[] = [];
      for (let at = 0; at < STATIC_SAMPLES_PER_SET; at += 1) samples.push(await timed(query));
      all.push(...samples);
      worstSet = Math.max(worstSet, percentile(samples, 0.95));
    }
    const budget = shape.contains === true ? CONTAINS_P95_MS : PARAMETER_SET_P95_MS;
    if (worstSet >= budget) passed = false;
    write({
      run: 'static',
      shape: shape.name,
      sets: shape.sets.length,
      p50_ms: rounded(percentile(all, 0.5)),
      p95_ms: rounded(percentile(all, 0.95)),
      worst_set_p95_ms: rounded(worstSet),
      budget_ms: budget,
    });
  }
  return passed;
}

async function scanRun(): Promise<boolean> {
  const query = {
    typeId: scanType,
    limit: LIST_LIMIT,
    filter: { field: scanField, op: 'eq', value: 'note 7' },
  };
  const samples: number[] = [];
  for (let at = 0; at < SCAN_SAMPLES; at += 1) {
    const started = performance.now();
    const page = await engine.queryNodes(scanTenant, query);
    if (!page.ok) throw new Error(page.error.code);
    samples.push(performance.now() - started);
  }
  const p95 = percentile(samples, 0.95);
  write({
    run: 'undeclared scan',
    items: SCAN_ITEMS,
    p50_ms: rounded(percentile(samples, 0.5)),
    p95_ms: rounded(p95),
    budget_ms: UNDECLARED_P95_MS,
  });
  return p95 < UNDECLARED_P95_MS;
}

const headRows = z.array(z.tuple([z.string(), z.string()]));

async function startWriter(): Promise<{ readonly finished: Promise<object> }> {
  const text = await superuser(
    `select coalesce(json_agg(json_build_array(id, head_version_id)), '[]')
     from app.nodes where type_id = '${typeId}';`,
    name,
  );
  const smallText = pageOf(8 * 1024);
  const largeText = pageOf(100 * 1024);
  const workerData: WriterInput = {
    url: urlFor('app', name),
    tenant,
    nodes: headRows.parse(JSON.parse(text)),
    fields,
    small: { content: await treeOf(smallText), text: smallText },
    large: { content: await treeOf(largeText), text: largeText },
    savesPerSecond: SAVES_PER_SECOND,
    slotChangeShare: SLOT_CHANGE_SHARE,
    seconds: env.DREFYN_BENCH_SECONDS,
  };
  const worker = new Worker(new URL('./query-writer.ts', import.meta.url), { workerData });
  return {
    finished: new Promise<object>((done, fail) => {
      worker.once('message', done);
      worker.once('error', fail);
    }),
  };
}

async function writeRun(): Promise<boolean> {
  const { finished } = await startWriter();
  const samples = new Map<string, number[]>(SHAPES.map((shape) => [shape.name, []]));
  const interval = 1000 / LISTS_PER_SECOND;
  const started = performance.now();
  const total = env.DREFYN_BENCH_SECONDS * LISTS_PER_SECOND;
  let maxLoad = 0;
  let failed = 0;
  for (let turn = 0; turn < total; turn += 1) {
    const wait = started + turn * interval - performance.now();
    if (wait > 0) await pause(wait);
    const shape = SHAPES[turn % SHAPES.length];
    const set = shape?.sets[Math.floor(turn / SHAPES.length) % shape.sets.length];
    if (shape === undefined || set === undefined) continue;
    try {
      samples.get(shape.name)?.push(await timed(set));
    } catch {
      failed += 1;
    }
    maxLoad = Math.max(maxLoad, loadavg()[0] ?? 0);
  }
  let passed = failed === 0;
  const declared: number[] = [];
  for (const shape of SHAPES) {
    const values = samples.get(shape.name) ?? [];
    const p95 = percentile(values, 0.95);
    const budget = shape.contains === true ? CONTAINS_P95_MS : DECLARED_P95_MS;
    if (p95 >= budget) passed = false;
    if (shape.contains !== true) declared.push(...values);
    write({
      run: 'writes',
      shape: shape.name,
      samples: values.length,
      p50_ms: rounded(percentile(values, 0.5)),
      p95_ms: rounded(p95),
      max_ms: rounded(Math.max(...values)),
      budget_ms: budget,
    });
  }
  const p99 = percentile(declared, 0.99);
  if (p99 >= OVERALL_P99_MS) passed = false;
  write({
    run: 'writes',
    shape: 'all declared',
    samples: declared.length,
    p50_ms: rounded(percentile(declared, 0.5)),
    p95_ms: rounded(percentile(declared, 0.95)),
    p99_ms: rounded(p99),
    budget_p99_ms: OVERALL_P99_MS,
    failed_lists: failed,
    max_load: rounded(maxLoad),
    void: maxLoad > VOID_LOAD,
    writer: await finished,
  });
  return passed && maxLoad <= VOID_LOAD;
}

process.exitCode = 1;
try {
  const version = await superuser(`show server_version;`, name);
  const pinned = version.trim().startsWith('18.');
  write({ postgres: version.trim(), pinned, items: ITEMS, cores: cpus().length });
  await seedAll();
  const outcomes = [pinned, await staticRun(), await scanRun(), await writeRun()];
  if (outcomes.every(Boolean)) process.exitCode = 0;
} finally {
  await closeDatabase(db);
  await teardown();
}
