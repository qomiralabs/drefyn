// What the tree lock costs an incident create, with no key and with one, in a status project that
// is quiet, busy with moves, flooded with incident updates, and stuck behind a held lock. Needs a
// stack:
//   COMPOSE_PROJECT_NAME=<stack> node bench/incident.ts
// A comparison and not a budget, so any server will do.
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { closeDatabase, createDatabase, parseDatabaseConfig, type Database } from '@drefyn/db';
import { createParseClient } from '@drefyn/mdx/client';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import {
  createEngine,
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  type Engine,
  type NodeId,
} from '../src/index.ts';
import { lockTree } from '../src/tree.ts';
import setup from '../test/support/global-setup.ts';
import { parseClientConfig } from '../test/support/parse-host.ts';
import { superuser, urlFor } from '../test/support/stack.ts';
import { percentile, rounded } from './support.ts';

const SAMPLES = 100;
const STUCK_SAMPLES = 10;
const SAMPLE_GAP_MS = 10;
const MOVERS = 4;
const FLOOD_CLIENTS = 16;
const HOLDER_CONFIG = { ...DEFAULT_ENGINE_CONFIG, poolCeiling: 1 };

const provided = new Map<string, string | null>();
const teardown = await setup({
  provide: (key: string, value: string | null) => provided.set(key, value),
} as never);
if (typeof teardown !== 'function') {
  throw new Error(`no stack: ${String(provided.get('engineStackAbsent'))}`);
}
const name = provided.get('engineDatabase') ?? '';
const parseUrl = provided.get('engineParseUrl') ?? '';

const open = (): Promise<Database> =>
  createDatabase(
    parseDatabaseConfig({
      DREFYN_DATABASE_URL: urlFor('app', name),
      DREFYN_DATABASE_SSL: 'disable',
    }),
  );

interface Project {
  readonly tenant: TenantRef;
  readonly incident: string;
  readonly update: string;
}

const seedProject = async (): Promise<Project> => {
  const [organization, project, incident, update] = Array.from({ length: 4 }, randomUUID);
  await superuser(
    `insert into app.organizations (organization_id, name, plan_tier)
       values ('${String(organization)}', 'Bench', 'self_hosted');
     insert into app.projects (id, organization_id, product, slug, name)
       values ('${String(project)}', '${String(organization)}', 'status',
               'p${String(project).slice(0, 8)}', 'Bench');
     insert into app.content_types (id, organization_id, project_id, family, key) values
       ('${String(incident)}', '${String(organization)}', '${String(project)}', 'status_incident',
        'incident'),
       ('${String(update)}', '${String(organization)}', '${String(project)}',
        'status_incident_update', 'update');`,
    name,
  );
  return {
    tenant: {
      organizationId: organizationId(String(organization)),
      projectId: projectId(String(project)),
    },
    incident: String(incident),
    update: String(update),
  };
};

const incidentIn = (engine: Engine, project: Project, orderKey?: string) =>
  engine.createNode({
    tenant: project.tenant,
    family: 'status_incident',
    typeId: project.incident,
    ...(orderKey === undefined ? {} : { orderKey }),
  });

const madeIn = async (engine: Engine, project: Project): Promise<NodeId> => {
  const made = await incidentIn(engine, project);
  if (!made.ok) throw new Error(`createNode refused: ${made.error.code}`);
  return made.value.nodeId;
};

async function sampled(samples: number, post: () => ReturnType<Engine['createNode']>) {
  const times: number[] = [];
  const refused = new Map<string, number>();
  for (let turn = 0; turn < samples; turn += 1) {
    const started = performance.now();
    const answer = await post();
    times.push(performance.now() - started);
    if (!answer.ok) {
      const code = answer.error.issues[0]?.code ?? answer.error.code;
      refused.set(code, (refused.get(code) ?? 0) + 1);
    }
    await pause(SAMPLE_GAP_MS);
  }
  return {
    samples,
    p50_ms: rounded(percentile(times, 0.5)),
    p95_ms: rounded(percentile(times, 0.95)),
    max_ms: rounded(Math.max(...times)),
    refused: Object.fromEntries(refused),
  };
}

const both = async (run: string, engine: Engine, project: Project, samples = SAMPLES) => {
  const line = async (key: 'none' | 'caller', post: () => ReturnType<Engine['createNode']>) => {
    process.stdout.write(`${JSON.stringify({ run, key, ...(await sampled(samples, post)) })}\n`);
  };
  await line('none', () => incidentIn(engine, project));
  await line('caller', () => incidentIn(engine, project, 'a5'));
};

// Clients that run until the case ends, each answer ignored: the point is the queue they make.
const crowdOf = (clients: number, work: () => Promise<unknown>) => {
  let going = true;
  const running = Array.from({ length: clients }, async () => {
    while (going) {
      await work();
      await pause(1);
    }
  });
  return async () => {
    going = false;
    await Promise.all(running);
  };
};

const db = await open();
const holderDb = await open();
const parse = createParseClient(parseClientConfig(parseUrl));
const engine = createEngine({
  store: databaseStore(db, DEFAULT_ENGINE_CONFIG),
  parse,
  parsePolicy: {
    version: 1,
    components: [],
    rawHtml: 'sanitize',
    remoteImages: 'proxy',
    linkProtocols: ['https'],
  },
  flags: { evaluate: () => Promise.resolve({ value: true }) },
});

try {
  await both('quiet', engine, await seedProject());

  const moving = await seedProject();
  const [first, second] = [await madeIn(engine, moving), await madeIn(engine, moving)];
  const stopMoves = crowdOf(MOVERS, () =>
    engine.moveNode({
      tenant: moving.tenant,
      nodeId: first,
      parentId: null,
      afterId: second,
      actor: { kind: 'system', job: 'bench' },
    }),
  );
  await both('moves', engine, moving);
  await stopMoves();

  const flooded = await seedProject();
  const opened = await madeIn(engine, flooded);
  const stopFlood = crowdOf(FLOOD_CLIENTS, () =>
    engine.createNode({
      tenant: flooded.tenant,
      family: 'status_incident_update',
      typeId: flooded.update,
      parentId: opened,
    }),
  );
  await both('updates', engine, flooded);
  await stopFlood();

  const stuck = await seedProject();
  const { promise: free, resolve: release } = Promise.withResolvers<undefined>();
  const { promise: taken, resolve: locked } = Promise.withResolvers<undefined>();
  const holder = databaseStore(holderDb, HOLDER_CONFIG).tenant(stuck.tenant, async (tx) => {
    await sql`set local idle_in_transaction_session_timeout = 0`.execute(tx);
    await lockTree(tx, stuck.tenant);
    locked(undefined);
    await free;
  });
  await taken;
  await both('stuck', engine, stuck, STUCK_SAMPLES);
  release(undefined);
  await holder;
} finally {
  await closeDatabase(db);
  await closeDatabase(holderDb);
  await teardown();
}
