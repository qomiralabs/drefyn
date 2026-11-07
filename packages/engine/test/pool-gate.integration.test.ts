import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { closeDatabase, createDatabase, parseDatabaseConfig, type Database } from '@drefyn/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  type EngineResult,
  type EngineStore,
  type NodeId,
} from '../src/index.ts';
import type { EngineTx } from '../src/store.ts';
import { lockTree } from '../src/tree.ts';
import {
  ACTOR,
  admin,
  buildEngine,
  database,
  newNode,
  openDatabase,
  seed,
  tree,
  type Built,
  type Seeded,
} from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';
import { urlFor } from './support/stack.ts';

const POOL = 10;
const CEILING = DEFAULT_ENGINE_CONFIG.poolCeiling;
const HOLDERS = 40;

const openPool = (poolMax: number, url = urlFor('app', database())) =>
  createDatabase(
    parseDatabaseConfig({
      DREFYN_DATABASE_URL: url,
      DREFYN_DATABASE_SSL: 'disable',
      DREFYN_DATABASE_POOL_MAX: String(poolMax),
    }),
  );

const codeOf = (result: EngineResult<unknown>) => (result.ok ? 'ok' : result.error.code);

// The stall must outlast the test, and the pool ends a transaction left idle.
const outlast = (tx: EngineTx) =>
  sql`set local idle_in_transaction_session_timeout = 0`.execute(tx);

let db: Database;
let holderDb: Database;
let built: Built;

const holders = (): EngineStore =>
  databaseStore(holderDb, { ...DEFAULT_ENGINE_CONFIG, poolCeiling: HOLDERS - 1 });

// Takes a lock for each tenant from a pool of its own, as a slow writer on another process would.
const withEachHeld = async <T>(
  tenants: readonly Seeded[],
  take: (tx: EngineTx, seeded: Seeded) => Promise<unknown>,
  work: () => Promise<T>,
): Promise<T> => {
  const { promise: free, resolve: release } = Promise.withResolvers<undefined>();
  const held = tenants.map((seeded) => {
    const { promise: taken, resolve: locked } = Promise.withResolvers<undefined>();
    const done = holders().tenant(seeded.tenant, async (tx) => {
      await outlast(tx);
      await take(tx, seeded);
      locked(undefined);
      await free;
    });
    return { taken, done };
  });
  await Promise.all(held.map(({ taken }) => taken));
  try {
    return await work();
  } finally {
    release(undefined);
    await Promise.all(held.map(({ done }) => done));
  }
};

// Connections of the pool under test waiting on the stall, as the server sees them.
const stalled = async (kind: string): Promise<number> =>
  Number(
    await admin(`select count(*) from pg_stat_activity
                 where datname = current_database() and wait_event_type = 'Lock'
                   and wait_event = '${kind}';`),
  );

const nodeOf = (nodes: ReadonlyMap<Seeded, NodeId>, seeded: Seeded): NodeId => {
  const node = nodes.get(seeded);
  if (node === undefined) throw new Error('no node');
  return node;
};

const seedMany = async (count: number) => {
  const seeded: Seeded[] = [];
  for (let at = 0; at < count; at += 1) seeded.push(await seed());
  return seeded;
};

// A closed loop per client, for as long as the test runs, as the security review drove it.
const crowdOf = <T>(clients: number, call: (client: number) => Promise<T>) => {
  const run = { going: true };
  const all = Array.from({ length: clients }, async (_, client) => {
    const seen: T[] = [];
    while (run.going) {
      seen.push(await call(client));
      await pause(5);
    }
    return seen;
  });
  return async () => {
    run.going = false;
    return Promise.all(all);
  };
};

const peakWhile = async (read: () => Promise<number>, work: () => Promise<void>) => {
  const run = { going: true, peak: 0 };
  const watching = (async () => {
    while (run.going) {
      run.peak = Math.max(run.peak, await read());
      await pause(20);
    }
  })();
  await work();
  run.going = false;
  await watching;
  return run.peak;
};

describeWithStack('the process wide ceiling against Postgres', () => {
  beforeAll(async () => {
    db = await openPool(POOL);
    holderDb = await openPool(HOLDERS);
    built = buildEngine(db);
  });
  afterAll(async () => {
    await closeDatabase(db);
    await closeDatabase(holderDb);
  });

  it('holds tree writes below the pool across 30 projects, and answers a neighbour', async () => {
    const crowd = await seedMany(30);
    const nodes = new Map<Seeded, NodeId>();
    for (const seeded of crowd) nodes.set(seeded, await newNode(built.engine, seeded));
    const neighbour = await seed();
    const page = await newNode(built.engine, neighbour);

    const { peak, codes, answers } = await withEachHeld(
      crowd,
      (tx, seeded) => lockTree(tx, seeded.tenant),
      async () => {
        const stop = crowdOf(120, (client) => {
          const seeded = crowd[client % crowd.length];
          if (seeded === undefined) throw new Error('no project');
          return built.engine.moveNode({
            tenant: seeded.tenant,
            nodeId: nodeOf(nodes, seeded),
            parentId: null,
            afterId: null,
          });
        });
        const seen: string[] = [];
        const most = await peakWhile(
          () => stalled('advisory'),
          async () => {
            while ((await stalled('advisory')) === 0) await pause(10);
            for (let turn = 0; turn < 20; turn += 1) {
              seen.push(codeOf(await built.engine.getHead(neighbour.tenant, page)));
              const { tenant, typeId } = neighbour;
              seen.push(codeOf(await built.engine.queryNodes(tenant, { typeId })));
              await pause(25);
            }
          },
        );
        return { peak: most, codes: (await stop()).flat().map(codeOf), answers: seen };
      },
    );

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(CEILING);
    expect(CEILING).toBeLessThan(POOL);
    expect(answers).toEqual(Array.from({ length: 40 }, () => 'ok'));
    expect(new Set(codes)).toEqual(new Set(['engine.unavailable']));
  });

  it('keeps three organizations at their list cap below the pool, and answers a fourth', async () => {
    const crowd = await seedMany(3);
    const quiet = await seed();
    await newNode(built.engine, quiet);
    const page = await newNode(built.engine, quiet);
    const inner = databaseStore(db, DEFAULT_ENGINE_CONFIG);
    const organizations = new Set(crowd.map(({ tenant }) => tenant.organizationId));
    const { promise: free, resolve: release } = Promise.withResolvers<undefined>();
    let holding = 0;
    const store: EngineStore = {
      ...inner,
      tenant: (tenant, work, options) =>
        inner.tenant(
          tenant,
          async (tx) => {
            const value = await work(tx);
            if (organizations.has(tenant.organizationId)) {
              holding += 1;
              await free;
            }
            return value;
          },
          options,
        ),
    };
    const { engine } = buildEngine(db, { store });

    const lists = crowd.flatMap(({ tenant, typeId }) =>
      Array.from({ length: DEFAULT_ENGINE_CONFIG.queryMaxInFlight }, () =>
        engine.queryNodes(tenant, { typeId }),
      ),
    );
    while (store.gate.load().running === 0) await pause(5);
    await pause(100);

    const answer = await engine.queryNodes(quiet.tenant, { typeId: quiet.typeId });
    const read = await engine.getHead(quiet.tenant, page);
    const held = holding;
    release(undefined);
    await Promise.all(lists);

    expect(answer.ok).toBe(true);
    expect(read.ok).toBe(true);
    expect(held).toBeGreaterThan(0);
    expect(held).toBeLessThan(CEILING);
    expect(store.gate.load()).toEqual({ running: 0, waiting: 0 });
  });

  it('holds saves stalled on a node below the pool, and a neighbour is answered', async () => {
    const crowd = await seedMany(30);
    const nodes = new Map<Seeded, NodeId>();
    for (const seeded of crowd) nodes.set(seeded, await newNode(built.engine, seeded));
    const neighbour = await seed();
    const page = await newNode(built.engine, neighbour);
    const content = await tree(built.parse, neighbour, 'Body.');

    const { peak, answers } = await withEachHeld(
      crowd,
      (tx, seeded) =>
        tx
          .selectFrom('nodes')
          .select('id')
          .where('organization_id', '=', seeded.tenant.organizationId)
          .where('project_id', '=', seeded.tenant.projectId)
          .where('id', '=', nodeOf(nodes, seeded))
          .forUpdate()
          .execute(),
      async () => {
        const stop = crowdOf(120, (client) => {
          const seeded = crowd[client % crowd.length];
          if (seeded === undefined) throw new Error('no project');
          return built.engine.saveDraft({
            tenant: seeded.tenant,
            nodeId: nodeOf(nodes, seeded),
            expectedHeadVersionId: null,
            content,
            origin: 'human',
            actor: ACTOR,
            idempotencyKey: randomUUID(),
          });
        });
        const seen: string[] = [];
        const most = await peakWhile(
          () => stalled('transactionid'),
          async () => {
            while ((await stalled('transactionid')) === 0) await pause(10);
            for (let turn = 0; turn < 40; turn += 1) {
              seen.push(codeOf(await built.engine.getHead(neighbour.tenant, page)));
              await pause(25);
            }
          },
        );
        await stop();
        return { peak: most, answers: seen };
      },
    );

    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(CEILING);
    expect(answers).toEqual(Array.from({ length: 40 }, () => 'ok'));
  });

  describe('at startup', () => {
    it('refuses a ceiling at the size of the pool it would guard', async () => {
      const small = await openPool(DEFAULT_ENGINE_CONFIG.poolCeiling);
      try {
        expect(() => databaseStore(small, DEFAULT_ENGINE_CONFIG)).toThrow(
          /DREFYN_ENGINE_POOL_CEILING.*DREFYN_DATABASE_POOL_MAX/,
        );
        expect(() =>
          databaseStore(small, {
            ...DEFAULT_ENGINE_CONFIG,
            poolCeiling: DEFAULT_ENGINE_CONFIG.poolCeiling - 1,
          }),
        ).not.toThrow();
      } finally {
        await closeDatabase(small);
      }
    });

    it('gives engines over one pool one gate, and each pool its own', async () => {
      const second = await openDatabase();
      try {
        const one = databaseStore(db, DEFAULT_ENGINE_CONFIG);
        expect(databaseStore(db, DEFAULT_ENGINE_CONFIG).gate).toBe(one.gate);
        expect(databaseStore(second, DEFAULT_ENGINE_CONFIG).gate).not.toBe(one.gate);
      } finally {
        await closeDatabase(second);
      }
    });
  });
});
