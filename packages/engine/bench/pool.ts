// What a stalled crowd costs a tenant that did nothing, on the real engine, Postgres and parse
// host. A helper pool holds each crowd project's tree lock or node row for the whole case, or a
// store wrapper keeps each crowd list's connection open, so the crowd never makes progress. The
// quiet tenant then reads, lists and saves. Needs a stack:
//   COMPOSE_PROJECT_NAME=<stack> node bench/pool.ts
// A comparison and not a budget, so any server will do. Exits 1 if the quiet tenant saw a failure.
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { closeDatabase, createDatabase, parseDatabaseConfig, type Database } from '@drefyn/db';
import { DEFAULT_LIMITS, type MdxRoot } from '@drefyn/mdx';
import { createParseClient } from '@drefyn/mdx/client';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { z } from 'zod';
import {
  createEngine,
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  type Engine,
  type EngineResult,
  type EngineStore,
  type NodeId,
} from '../src/index.ts';
import type { EngineTx } from '../src/store.ts';
import { lockTree } from '../src/tree.ts';
import setup from '../test/support/global-setup.ts';
import { parseClientConfig } from '../test/support/parse-host.ts';
import { superuser, urlFor } from '../test/support/stack.ts';
import { percentile, rounded } from './support.ts';

const CLIENTS_PER_PROJECT = 4;
const SAMPLES = 15;
const SAMPLE_GAP_MS = 50;
const SETTLE_MS = 300;
const POOL_MAX = 10;
const HOLDER_POOL = 40;
const HOLDER_CONFIG = { ...DEFAULT_ENGINE_CONFIG, poolCeiling: HOLDER_POOL - 1 };

const provided = new Map<string, string | null>();
const teardown = await setup({
  provide: (key: string, value: string | null) => provided.set(key, value),
} as never);
if (typeof teardown !== 'function') {
  throw new Error(`no stack: ${String(provided.get('engineStackAbsent'))}`);
}
const name = provided.get('engineDatabase') ?? '';
const parseUrl = provided.get('engineParseUrl') ?? '';

const open = (poolMax: number) =>
  createDatabase(
    parseDatabaseConfig({
      DREFYN_DATABASE_URL: urlFor('app', name),
      DREFYN_DATABASE_SSL: 'disable',
      DREFYN_DATABASE_POOL_MAX: String(poolMax),
    }),
  );

interface Seeded {
  readonly tenant: TenantRef;
  readonly typeId: string;
  readonly organization: string;
  readonly project: string;
}

const seedOne = async (shared?: string): Promise<Seeded> => {
  const organization = shared ?? randomUUID();
  const project = randomUUID();
  const typeId = randomUUID();
  await superuser(
    `${
      shared === undefined
        ? `insert into app.organizations (organization_id, name, plan_tier)
             values ('${organization}', 'Bench', 'self_hosted');`
        : ''
    }
insert into app.projects (id, organization_id, product, slug, name)
  values ('${project}', '${organization}', 'docs', 'p${project.slice(0, 8)}', 'Bench');
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${typeId}', '${organization}', '${project}', 'docs_page', 'page');`,
    name,
  );
  return {
    tenant: { organizationId: organizationId(organization), projectId: projectId(project) },
    typeId,
    organization,
    project,
  };
};

const parse = createParseClient(parseClientConfig(parseUrl));
const parsePolicy = {
  version: 1,
  components: [] as string[],
  rawHtml: 'sanitize',
  remoteImages: 'proxy',
  linkProtocols: ['https', 'http', 'mailto'],
} as const;

// The pool ends a transaction left idle for a minute, and a stall has to outlast the whole case.
const outlast = (tx: EngineTx) =>
  sql`set local idle_in_transaction_session_timeout = 0`.execute(tx);

const engineOver = (store: EngineStore) =>
  createEngine({
    store,
    parse,
    parsePolicy,
    flags: { evaluate: () => Promise.resolve({ value: true }) },
  });

const made = async (engine: Engine, seeded: Seeded): Promise<NodeId> => {
  const node = await engine.createNode({
    tenant: seeded.tenant,
    family: 'docs_page',
    typeId: seeded.typeId,
  });
  if (!node.ok) throw new Error(`createNode refused: ${node.error.code}`);
  return node.value.nodeId;
};

const pageTree = async (tenant: TenantRef): Promise<MdxRoot> => {
  const answer = await parse.parse({
    tenant,
    path: 'bench',
    source: '# Bench\n\nA short page.\n',
    dialect: 'md',
    policy: { ...parsePolicy, components: new Set(), limits: DEFAULT_LIMITS },
  });
  if (!answer.ok) throw new Error('the page was refused');
  return answer.value.ast;
};

const actor = { kind: 'system', job: 'bench' } as const;

interface Quiet {
  readonly seeded: Seeded;
  readonly node: NodeId;
  readonly content: MdxRoot;
}

const quietTenant = async (engine: Engine): Promise<Quiet> => {
  const seeded = await seedOne();
  return {
    seeded,
    node: await made(engine, seeded),
    content: await pageTree(seeded.tenant),
  };
};

const summary = (times: readonly number[], failed: number) => ({
  samples: times.length,
  p50_ms: rounded(percentile(times, 0.5)),
  p95_ms: rounded(percentile(times, 0.95)),
  max_ms: rounded(Math.max(...times)),
  failed,
});

async function sampled(work: () => Promise<EngineResult<unknown>>) {
  const times: number[] = [];
  let failed = 0;
  for (let turn = 0; turn < SAMPLES; turn += 1) {
    const started = performance.now();
    const answer = await work();
    times.push(performance.now() - started);
    if (!answer.ok) failed += 1;
    await pause(SAMPLE_GAP_MS);
  }
  return summary(times, failed);
}

const busyConnections = async (): Promise<number> =>
  Number(
    await superuser(
      `select count(*) from pg_stat_activity
       where datname = current_database() and application_name = 'drefyn-app'
         and state <> 'idle';`,
      name,
    ),
  );

// Asks the database, not the engine, how many connections the crowd is holding, through the case.
const watchConnections = () => {
  const watch = { going: true, peak: 0 };
  const watching = (async () => {
    while (watch.going) {
      watch.peak = Math.max(watch.peak, await busyConnections());
      await pause(100);
    }
  })();
  return async () => {
    watch.going = false;
    await watching;
    return watch.peak;
  };
};

async function measure(engine: Engine, quiet: Quiet, holders: number) {
  await pause(SETTLE_MS);
  const stop = watchConnections();
  const { tenant, typeId } = quiet.seeded;
  const reads = await sampled(() => engine.getHead(tenant, quiet.node));
  const lists = await sampled(() => engine.queryNodes(tenant, { typeId }));
  let head: string | null = null;
  const saves = await sampled(async () => {
    const saved = await engine.saveDraft({
      tenant,
      nodeId: quiet.node,
      expectedHeadVersionId: head as never,
      content: quiet.content,
      origin: 'human',
      actor,
      idempotencyKey: randomUUID(),
    });
    if (saved.ok) head = saved.value.versionId;
    return saved;
  });
  return { reads, lists, saves, peak_connections_under_load: (await stop()) - holders };
}

const crowdLoop = (work: () => Promise<unknown>, stopped: () => boolean) =>
  Array.from({ length: CLIENTS_PER_PROJECT }, async () => {
    while (!stopped()) {
      await work();
      await pause(5);
    }
  });

const holderStore = (holder: Database) => databaseStore(holder, HOLDER_CONFIG);

// A pool of its own holds the stall, so it costs the pool under test nothing.
async function stalledTree(projects: number, sameOrganization: boolean, holder: Database) {
  const db = await open(POOL_MAX);
  const engine = engineOver(databaseStore(db, DEFAULT_ENGINE_CONFIG));
  const quiet = await quietTenant(engine);
  const shared = sameOrganization ? randomUUID() : undefined;
  if (shared !== undefined) {
    await superuser(
      `insert into app.organizations (organization_id, name, plan_tier)
         values ('${shared}', 'Bench', 'self_hosted');`,
      name,
    );
  }
  const crowd: { seeded: Seeded; node: NodeId }[] = [];
  for (let at = 0; at < projects; at += 1) {
    const seeded = await seedOne(shared);
    crowd.push({ seeded, node: await made(engine, seeded) });
  }
  const { promise: free, resolve: release } = Promise.withResolvers<undefined>();
  const locks = crowd.map(({ seeded }) => {
    const { promise: taken, resolve: locked } = Promise.withResolvers<undefined>();
    const held = holderStore(holder).tenant(seeded.tenant, async (tx) => {
      await outlast(tx);
      await lockTree(tx, seeded.tenant);
      locked(undefined);
      await free;
    });
    return { taken, held };
  });
  await Promise.all(locks.map(({ taken }) => taken));
  let stopped = false;
  const clients = crowd.flatMap(({ seeded, node }) =>
    crowdLoop(
      () => engine.moveNode({ tenant: seeded.tenant, nodeId: node, parentId: null, afterId: null }),
      () => stopped,
    ),
  );
  const result = await measure(engine, quiet, projects);
  stopped = true;
  release(undefined);
  await Promise.all(clients);
  await Promise.all(locks.map(({ held }) => held));
  await closeDatabase(db);
  return result;
}

async function heldLists(organizations: number, listsEach: number) {
  const db = await open(POOL_MAX);
  const inner = databaseStore(db, DEFAULT_ENGINE_CONFIG);
  const crowded = new Set<string>();
  const { promise: free, resolve: release } = Promise.withResolvers<undefined>();
  const store: EngineStore = {
    ...inner,
    tenant: (tenant, work, options) =>
      inner.tenant(
        tenant,
        async (tx) => {
          const value = await work(tx);
          if (crowded.has(tenant.organizationId)) {
            await outlast(tx);
            await free;
          }
          return value;
        },
        options,
      ),
  };
  const engine = engineOver(store);
  const quiet = await quietTenant(engine);
  const crowd: Seeded[] = [];
  for (let at = 0; at < organizations; at += 1) crowd.push(await seedOne());
  for (const seeded of crowd) crowded.add(seeded.tenant.organizationId);
  const lists = crowd.flatMap((seeded) =>
    Array.from({ length: listsEach }, () =>
      engine.queryNodes(seeded.tenant, { typeId: seeded.typeId }),
    ),
  );
  const result = await measure(engine, quiet, 0);
  release(undefined);
  await Promise.all(lists);
  await closeDatabase(db);
  return result;
}

async function stalledSaves(projects: number, holder: Database) {
  const db = await open(POOL_MAX);
  const engine = engineOver(databaseStore(db, DEFAULT_ENGINE_CONFIG));
  const quiet = await quietTenant(engine);
  const crowd: { seeded: Seeded; node: NodeId; content: MdxRoot }[] = [];
  for (let at = 0; at < projects; at += 1) {
    const seeded = await seedOne();
    crowd.push({
      seeded,
      node: await made(engine, seeded),
      content: await pageTree(seeded.tenant),
    });
  }
  const { promise: free, resolve: release } = Promise.withResolvers<undefined>();
  const locks = crowd.map(({ seeded, node }) => {
    const { promise: taken, resolve: locked } = Promise.withResolvers<undefined>();
    const held = holderStore(holder).tenant(seeded.tenant, async (tx) => {
      await outlast(tx);
      await tx
        .selectFrom('nodes')
        .select('id')
        .where('organization_id', '=', seeded.tenant.organizationId)
        .where('project_id', '=', seeded.tenant.projectId)
        .where('id', '=', node)
        .forUpdate()
        .execute();
      locked(undefined);
      await free;
    });
    return { taken, held };
  });
  await Promise.all(locks.map(({ taken }) => taken));
  let stopped = false;
  const clients = crowd.flatMap(({ seeded, node, content }) =>
    crowdLoop(
      () =>
        engine.saveDraft({
          tenant: seeded.tenant,
          nodeId: node,
          expectedHeadVersionId: null,
          content,
          origin: 'human',
          actor,
          idempotencyKey: randomUUID(),
        }),
      () => stopped,
    ),
  );
  const result = await measure(engine, quiet, projects);
  stopped = true;
  release(undefined);
  await Promise.all(clients);
  await Promise.all(locks.map(({ held }) => held));
  await closeDatabase(db);
  return result;
}

const write = (line: object) => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const failedIn = (result: Awaited<ReturnType<typeof measure>>) =>
  result.reads.failed + result.lists.failed + result.saves.failed;

const report = z.string().parse(process.env['DREFYN_BENCH_LABEL'] ?? 'run');

process.exitCode = 1;
let failures = 0;
const holder = await open(HOLDER_POOL);
try {
  const cases: readonly [string, () => ReturnType<typeof measure>][] = [
    ['idle', () => stalledTree(0, false, holder)],
    ['tree, 5 projects, 5 organizations', () => stalledTree(5, false, holder)],
    ['tree, 10 projects, 10 organizations', () => stalledTree(10, false, holder)],
    ['tree, 30 projects, 30 organizations', () => stalledTree(30, false, holder)],
    ['tree, 30 projects, 1 organization', () => stalledTree(30, true, holder)],
    ['lists, 3 organizations holding 4 each', () => heldLists(3, 4)],
    ['saves, 5 projects, 5 organizations', () => stalledSaves(5, holder)],
    ['saves, 30 projects, 30 organizations', () => stalledSaves(30, holder)],
  ];
  for (const [label, run] of cases) {
    const result = await run();
    failures += failedIn(result);
    write({ run: report, case: label, ...result });
  }
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await closeDatabase(holder);
  await teardown();
}
