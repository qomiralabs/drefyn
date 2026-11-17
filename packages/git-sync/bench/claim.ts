// claimDelivery against the budget: p95 under 10 ms with 10,000 queued deliveries across
// 1,000 tenants, each claim coalescing its binding's ten. Needs a stack:
//   COMPOSE_PROJECT_NAME=<stack> node bench/claim.ts
// Runs above load 10 are void and say so.
import { cpus, loadavg } from 'node:os';
import { closeDatabase, createDatabase, parseDatabaseConfig } from '@drefyn/db';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { createGitSyncStore, databaseGitSyncDb } from '../src/index.ts';
import setup from '../test/support/global-setup.ts';
import { superuser, urlFor } from '../test/support/stack.ts';

const P95_MS = 10;
const VOID_LOAD = 10;
const TENANTS = 1000;
const QUEUED_PER_BINDING = 10;
const SAMPLES = 300;
const WARM_UP = 20;

const provided = new Map<string, string | null>();
const teardown = await setup({
  provide: (key: string, value: string | null) => provided.set(key, value),
} as never);
if (typeof teardown !== 'function') {
  throw new Error(`no stack: ${String(provided.get('gitSyncStackAbsent'))}`);
}
const name = provided.get('gitSyncDatabase') ?? '';

await superuser(
  `
create temp table bench_tenants (organization uuid, project uuid, binding uuid);
insert into bench_tenants
  select gen_random_uuid(), gen_random_uuid(), uuidv7() from generate_series(1, ${String(TENANTS)});
insert into app.organizations (organization_id, name, plan_tier)
  select organization, 'Bench', 'self_hosted' from bench_tenants;
insert into app.projects (id, organization_id, product, slug, name)
  select project, organization, 'docs', 'bench', 'Bench' from bench_tenants;
insert into app.git_bindings (id, organization_id, project_id, installation_id, repository_id,
    owner, name, branch, folder)
  select binding, organization, project, 1, 2, 'acme', 'docs', 'main', 'docs' from bench_tenants;
insert into app.git_deliveries (organization_id, project_id, binding_id, delivery_id, received_at)
  select organization, project, binding, 'gh-' || g, now() - (g || ' seconds')::interval
  from bench_tenants, generate_series(1, ${String(QUEUED_PER_BINDING)}) g
  order by random();
vacuum analyze app.git_deliveries;
vacuum analyze app.git_bindings;`,
  name,
);

const rows = (
  await superuser(
    `select organization_id || ' ' || project_id || ' ' || id from app.git_bindings;`,
    name,
  )
)
  .split('\n')
  .filter((line) => line !== '');

const targets = rows.map((line) => {
  const [organization = '', project = '', binding = ''] = line.split(' ');
  const tenant: TenantRef = {
    organizationId: organizationId(organization),
    projectId: projectId(project),
  };
  return { tenant, binding };
});

const db = await createDatabase(
  parseDatabaseConfig({ DREFYN_DATABASE_URL: urlFor('app', name), DREFYN_DATABASE_SSL: 'disable' }),
);
const store = createGitSyncStore({
  db: databaseGitSyncDb(db),
  gate: { check: () => Promise.resolve(null) },
});

const times: number[] = [];
let exitCode = 0;
try {
  for (let i = 0; i < WARM_UP + SAMPLES; i += 1) {
    const target = targets[i % targets.length];
    if (target === undefined) throw new Error('no bench tenant');
    const started = performance.now();
    const result = await store.claimDelivery(target.tenant, target.binding, () =>
      Promise.resolve('done'),
    );
    const ms = performance.now() - started;
    if (!result.ok || result.value.superseded !== QUEUED_PER_BINDING - 1) {
      throw new Error(`claim did not coalesce: ${JSON.stringify(result)}`);
    }
    if (i >= WARM_UP) times.push(ms);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
  const p50 = times[Math.ceil(times.length * 0.5) - 1] ?? Number.POSITIVE_INFINITY;
  const load = loadavg()[0] ?? 0;
  const voided = load > VOID_LOAD;
  console.log(
    JSON.stringify({
      bench: 'claimDelivery',
      queued: TENANTS * QUEUED_PER_BINDING,
      tenants: TENANTS,
      samples: times.length,
      p50_ms: Number(p50.toFixed(2)),
      p95_ms: Number(p95.toFixed(2)),
      budget_ms: P95_MS,
      load: Number(load.toFixed(1)),
      cpus: cpus().length,
      verdict: voided ? 'void, load too high' : p95 < P95_MS ? 'pass' : 'fail',
    }),
  );
  if (!voided && p95 >= P95_MS) exitCode = 1;
} finally {
  await closeDatabase(db);
  await teardown();
}
process.exitCode = exitCode;
