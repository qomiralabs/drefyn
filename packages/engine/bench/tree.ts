// A root list of 50 on the largest tenant, p95 under 50 ms and served by the partial index, and
// what one move costs beside it. Needs a stack:
//   COMPOSE_PROJECT_NAME=<stack> node bench/tree.ts
// Only a run on the pinned Postgres 18 image counts, so any other server exits 1 whatever the
// times.
import { randomUUID } from 'node:crypto';
import { closeDatabase, createDatabase, parseDatabaseConfig, withTenant } from '@drefyn/db';
import { idOf, organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { z } from 'zod';
import { createEngine, databaseStore, DEFAULT_ENGINE_CONFIG, type NodeId } from '../src/index.ts';
import setup from '../test/support/global-setup.ts';
import { superuser, urlFor } from '../test/support/stack.ts';
import { percentile, rounded } from './support.ts';

const ROOT_LIST_P95_MS = 50;
const SAMPLES = 400;
const LIST_LIMIT = 50;
const TAIL_TENANTS = 400;
const TAIL_ITEMS = 50;

const env = z
  .object({
    DREFYN_BENCH_NODES: z
      .string()
      .regex(/^[0-9]{3,6}$/)
      .default('200000')
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

const organization = randomUUID();
const project = randomUUID();
const typeId = randomUUID();
const tenant: TenantRef = {
  organizationId: organizationId(organization),
  projectId: projectId(project),
};

// 'f' and six digits is a valid key. The heap is shuffled, so a list in key order reads pages
// all over the table, as a site that has been edited for years does.
const seed = () =>
  superuser(
    `
create temporary table bench_tenants (organization uuid, project uuid, type uuid, nodes int);
insert into bench_tenants values ('${organization}', '${project}', '${typeId}', ${String(ITEMS)});
insert into bench_tenants
  select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), ${String(TAIL_ITEMS)}
  from generate_series(1, ${String(TAIL_TENANTS)});
insert into app.organizations (organization_id, name, plan_tier)
  select organization, 'Bench', 'self_hosted' from bench_tenants;
insert into app.projects (id, organization_id, product, slug, name)
  select project, organization, 'docs', 'bench', 'Bench' from bench_tenants;
insert into app.content_types (id, organization_id, project_id, family, key)
  select type, organization, project, 'docs_page', 'page' from bench_tenants;
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle)
  select organization, project, 'docs_page', type, 'f' || lpad(g::text, 6, '0'), 'draft'
  from bench_tenants, generate_series(1, nodes) g
  order by random();
vacuum analyze app.nodes;`,
    name,
  );

const db = await createDatabase(
  parseDatabaseConfig({ DREFYN_DATABASE_URL: urlFor('app', name), DREFYN_DATABASE_SSL: 'disable' }),
);
const engine = createEngine({
  store: databaseStore(db, DEFAULT_ENGINE_CONFIG),
  parse: { print: () => Promise.reject(new Error('a move prints nothing')) },
  parsePolicy: {
    version: 1,
    components: [],
    rawHtml: 'sanitize',
    remoteImages: 'proxy',
    linkProtocols: ['https'],
  },
  flags: { evaluate: () => Promise.resolve({ value: true }) },
});

const write = (line: object) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const rootList = (from: string) =>
  withTenant(db, tenant, (tx) =>
    tx
      .selectFrom('nodes')
      .select(['id', 'order_key'])
      .where('organization_id', '=', tenant.organizationId)
      .where('project_id', '=', tenant.projectId)
      .where('parent_id', 'is', null)
      .where('deleted_at', 'is', null)
      .where('order_key', '>', from)
      .orderBy('order_key')
      .limit(LIST_LIMIT)
      .execute(),
  );

const plan = () =>
  withTenant(db, tenant, async (tx) => {
    const { rows } = await sql<{ 'QUERY PLAN': string }>`
      explain select id from app.nodes
      where organization_id = ${tenant.organizationId}::uuid
        and project_id = ${tenant.projectId}::uuid
        and parent_id is null and deleted_at is null
      order by order_key limit 50`.execute(tx);
    return rows.map((row) => row['QUERY PLAN']).join('\n');
  });

async function timed(samples: number, work: (turn: number) => Promise<unknown>) {
  const times: number[] = [];
  for (let turn = 0; turn < samples; turn += 1) {
    const started = performance.now();
    await work(turn);
    times.push(performance.now() - started);
  }
  return {
    samples,
    p50_ms: rounded(percentile(times, 0.5)),
    p95_ms: rounded(percentile(times, 0.95)),
    p99_ms: rounded(percentile(times, 0.99)),
  };
}

process.exitCode = 1;
try {
  const version = (await superuser(`show server_version;`, name)).trim();
  const pinned = version.startsWith('18.');
  write({ postgres: version, pinned, items: ITEMS });
  await seed();

  const onIndex = (await plan()).includes('nodes_roots');
  const step = Math.floor(ITEMS / SAMPLES);
  const keyAt = (turn: number) => `f${String(turn * step).padStart(6, '0')}`;
  const lists = await timed(SAMPLES, (turn) => rootList(keyAt(turn)));
  write({ run: 'root list', ...lists, budget_p95_ms: ROOT_LIST_P95_MS, on_partial_index: onIndex });

  const page = await rootList('f');
  const ids = page.map((row) => idOf('nod', row.id));
  const moves = await timed(SAMPLES, async (turn) => {
    const nodeId = ids[turn % ids.length] as NodeId;
    const moved = await engine.moveNode({
      tenant,
      nodeId,
      parentId: null,
      afterId: ids[(turn + 25) % ids.length] ?? null,
    });
    if (!moved.ok) throw new Error(`moveNode refused: ${moved.error.code}`);
  });
  write({ run: 'move', ...moves });

  if (pinned && onIndex && lists.p95_ms < ROOT_LIST_P95_MS) process.exitCode = 0;
} finally {
  await closeDatabase(db);
  await teardown();
}
