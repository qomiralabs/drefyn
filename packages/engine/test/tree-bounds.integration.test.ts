import { randomUUID } from 'node:crypto';
import { closeDatabase, type Database } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  type Engine,
  type EngineResult,
  type NodeId,
} from '../src/index.ts';
import type { EngineTx } from '../src/store.ts';
import { lockTree, MAX_TREE_LEVELS, TREE_LOCK_WAIT_MS } from '../src/tree.ts';
import { lockNode } from '../src/write.ts';
import {
  ACTOR,
  admin,
  buildEngine,
  openDatabase,
  save,
  seed,
  type Built,
  type Seeded,
} from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';

let db: Database;
let holderDb: Database;
let built: Built;
let engine: Engine;

const codeOf = (result: EngineResult<unknown>) => (result.ok ? 'ok' : result.error.code);
const issueOf = (result: EngineResult<unknown>) =>
  result.ok ? null : (result.error.issues[0]?.code ?? null);

const create = (seeded: Seeded, parentId: NodeId | null = null, orderKey?: string) =>
  engine.createNode({
    tenant: seeded.tenant,
    family: 'docs_page',
    typeId: seeded.typeId,
    parentId,
    ...(orderKey === undefined ? {} : { orderKey }),
  });

const created = async (seeded: Seeded, parentId: NodeId | null = null): Promise<NodeId> => {
  const made = await create(seeded, parentId);
  if (!made.ok) throw new Error(`createNode refused: ${made.error.code}`);
  return made.value.nodeId;
};

const move = (seeded: Seeded, nodeId: NodeId, parentId: NodeId | null) =>
  engine.moveNode({ tenant: seeded.tenant, nodeId, parentId, afterId: null, actor: ACTOR });

// A chain written straight to the table, which is also how a row deeper than the cap can exist:
// nothing the engine offers can build one now. Top first.
const chain = async (
  seeded: Seeded,
  length: number,
  under: NodeId | null = null,
): Promise<readonly NodeId[]> => {
  const ids = Array.from({ length }, () => randomUUID());
  const values = ids
    .map((id, at) => {
      const parent = at === 0 ? under : (ids[at - 1] ?? null);
      return `('${id}'::uuid, ${parent === null ? 'null' : `'${parent}'::uuid`})`;
    })
    .join(',\n');
  await admin(`
insert into app.nodes (id, organization_id, project_id, family, type_id, order_key, lifecycle, parent_id)
  select v.id, '${seeded.organization}', '${seeded.project}', 'docs_page', '${seeded.typeId}',
         'a0', 'draft', v.parent
  from (values ${values}) as v (id, parent);
insert into app.node_filter_rows (organization_id, project_id, type_id, node_id)
  select organization_id, project_id, type_id, id from app.nodes
  where project_id = '${seeded.project}' and id = any(array[${ids.map((id) => `'${id}'::uuid`).join(',')}]);
`);
  return ids.map((id) => idOf('nod', id));
};

const at = (nodes: readonly NodeId[], index: number): NodeId => {
  const node = nodes.at(index);
  if (node === undefined) throw new Error(`no node at ${String(index)}`);
  return node;
};

const fingerprint = (seeded: Seeded) =>
  admin(
    `select coalesce(string_agg(id || ':' || coalesce(parent_id::text, '') || ':' || order_key,
                                ',' order by id), '')
     from app.nodes where project_id = '${seeded.project}';`,
  );

// Deepest level in the project, walked here and not with anything the engine does.
const deepest = async (seeded: Seeded): Promise<number> =>
  Number(
    await admin(`
with recursive walk (id, level) as (
  select id, 1 from app.nodes where project_id = '${seeded.project}' and parent_id is null
  union all
  select n.id, walk.level + 1 from app.nodes n join walk on n.parent_id = walk.id
)
select max(level) from walk;`),
  );

const lockWaiters = async (): Promise<number> =>
  Number(
    await admin(`select count(*) from pg_stat_activity
                 where datname = current_database() and wait_event_type = 'Lock'
                   and wait_event = 'advisory';`),
  );

const sqlShow = (tx: EngineTx) =>
  sql<{ lock_timeout: string }>`select current_setting('lock_timeout') as lock_timeout`.execute(tx);

const pause = (ms: number) =>
  new Promise<void>((done) => {
    setTimeout(done, ms);
  });

// Runs work with the project's tree lock held by another pool, as a slow move on another process
// would hold it. A hold of its own stands in for any other lock that process could sit on.
const withLockHeld = async <T>(
  seeded: Seeded,
  work: () => Promise<T>,
  hold: (tx: EngineTx) => Promise<unknown> = (tx) => lockTree(tx, seeded.tenant),
): Promise<T> => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let locked: () => void = () => undefined;
  const taken = new Promise<void>((done) => {
    locked = done;
  });
  const holder = databaseStore(holderDb, DEFAULT_ENGINE_CONFIG).tenant(
    seeded.tenant,
    async (tx) => {
      await hold(tx);
      locked();
      await held;
    },
  );
  await taken;
  try {
    return await work();
  } finally {
    release();
    await holder;
  }
};

describeWithStack('tree bounds against Postgres', () => {
  beforeAll(async () => {
    db = await openDatabase();
    holderDb = await openDatabase();
    built = buildEngine(db);
    ({ engine } = built);
  });
  afterAll(async () => {
    await closeDatabase(db);
    await closeDatabase(holderDb);
  });

  describe('the cap on create', () => {
    it('fills the last level and refuses the one after it, keyed or not', async () => {
      const home = await seed();
      const nodes = await chain(home, MAX_TREE_LEVELS - 1);
      const last = await created(home, at(nodes, -1));
      expect(await deepest(home)).toBe(MAX_TREE_LEVELS);

      const before = await fingerprint(home);
      for (const refused of [await create(home, last), await create(home, last, 'a5')]) {
        expect(codeOf(refused)).toBe('engine.validation_failed');
        expect(issueOf(refused)).toBe('engine.tree_too_deep');
      }
      expect(await fingerprint(home)).toBe(before);
    });
  });

  describe('the cap on move', () => {
    it('counts the height of what moves', async () => {
      const home = await seed();
      const parents = await chain(home, 60);
      const branch = await chain(home, 5);
      const top = at(branch, 0);

      const before = await fingerprint(home);
      const refused = await move(home, top, at(parents, -1));
      expect(codeOf(refused)).toBe('engine.validation_failed');
      expect(issueOf(refused)).toBe('engine.tree_too_deep');
      expect(await fingerprint(home)).toBe(before);

      expect(codeOf(await move(home, top, at(parents, -2)))).toBe('ok');
      expect(await deepest(home)).toBe(MAX_TREE_LEVELS);
    });

    it('counts a branch deep under a wide one, not just the first child', async () => {
      const home = await seed();
      const parents = await chain(home, 60);
      const top = await created(home);
      for (let index = 0; index < 5; index += 1) await created(home, top);
      const narrow = await created(home, top);
      await chain(home, 3, narrow);
      expect(issueOf(await move(home, top, at(parents, -1)))).toBe('engine.tree_too_deep');
    });

    it('never lets two moves that fit alone stack past the cap together', async () => {
      for (let round = 0; round < 10; round += 1) {
        const home = await seed();
        const base = await chain(home, 30);
        const [upper, lower] = [await chain(home, 20), await chain(home, 20)];
        const results = await Promise.all([
          move(home, at(upper, 0), at(base, -1)),
          move(home, at(lower, 0), at(upper, -1)),
        ]);
        expect(results.map(codeOf).sort()).toEqual(['engine.validation_failed', 'ok']);
        expect(await deepest(home)).toBeLessThanOrEqual(MAX_TREE_LEVELS);
      }
    });

    it('never lets a create land under a branch that a move takes past the cap', async () => {
      for (let round = 0; round < 10; round += 1) {
        const home = await seed();
        const parents = await chain(home, 32);
        const branch = await chain(home, 32);
        const results = await Promise.all([
          move(home, at(branch, 0), at(parents, -1)),
          create(home, at(branch, -1), 'a5'),
        ]);
        expect(results.map(codeOf)).toContain('ok');
        expect(await deepest(home)).toBeLessThanOrEqual(MAX_TREE_LEVELS);
      }
    });
  });

  describe('rows already past the cap', () => {
    const deep = async () => {
      const home = await seed();
      const nodes = await chain(home, MAX_TREE_LEVELS + 36);
      return { home, nodes };
    };

    it('reads them, lists them, and saves them', async () => {
      const { home, nodes } = await deep();
      const tail = at(nodes, -1);
      expect(codeOf(await engine.getHead(home.tenant, tail))).toBe('ok');
      expect(codeOf(await engine.listVersions(home.tenant, tail, {}))).toBe('ok');
      const listed = await engine.queryNodes(home.tenant, { typeId: home.typeId, limit: 100 });
      expect(listed.ok && listed.value.items.length).toBe(nodes.length);
      const saved = await save(built, home, tail, null, 'still here\n');
      expect(saved.seq).toBe(1);
    });

    it('moves them out, up and along, and never deeper', async () => {
      const { home, nodes } = await deep();
      const tail = at(nodes, -1);
      const sibling = await chain(home, 1, at(nodes, -2));

      expect(codeOf(await move(home, tail, at(nodes, -2)))).toBe('ok');
      expect(codeOf(await move(home, at(sibling, 0), at(nodes, 2)))).toBe('ok');
      const refused = await move(home, at(sibling, 0), tail);
      expect(issueOf(refused)).toBe('engine.tree_too_deep');
      expect(issueOf(await create(home, tail))).toBe('engine.tree_too_deep');

      expect(codeOf(await move(home, at(nodes, 70), null))).toBe('ok');
      expect(await deepest(home)).toBeLessThan(nodes.length);
    });

    it('refuses a cycle far down a chain past the cap, in either answer, with no write', async () => {
      const { home, nodes } = await deep();
      const before = await fingerprint(home);
      const result = await move(home, at(nodes, 0), at(nodes, -1));
      expect(codeOf(result)).toBe('engine.validation_failed');
      expect(await fingerprint(home)).toBe(before);
    });

    it('sees a deleted branch only as far as the walk reaches', async () => {
      const { home, nodes } = await deep();
      await admin(`update app.nodes set deleted_at = now() where id = '${at(nodes, 0)}';`);
      expect(codeOf(await move(home, at(nodes, 10), null))).toBe('engine.not_found');
      expect(codeOf(await move(home, at(nodes, MAX_TREE_LEVELS + 1), null))).toBe('ok');
    });

    it('stops at the cap on a cycle already in the data', async () => {
      const home = await seed();
      const [a, b, loose] = [await created(home), await created(home), await created(home)];
      await admin(`update app.nodes set parent_id = '${b}' where id = '${a}';
                   update app.nodes set parent_id = '${a}' where id = '${b}';`);
      expect(issueOf(await move(home, loose, a))).toBe('engine.tree_too_deep');
    });
  });

  describe('a deleted branch', () => {
    const rowsOf = (seeded: Seeded) =>
      admin(`select (select count(*) from app.nodes where project_id = '${seeded.project}') || ':' ||
                    (select count(*) from app.node_filter_rows where project_id = '${seeded.project}');`);

    it('refuses a create under a node inside it, keyed or not, with nothing written', async () => {
      const home = await seed();
      const top = await created(home);
      const inside = await created(home, await created(home, top));
      await admin(`update app.nodes set deleted_at = now() where id = '${top}';`);
      const [before, rows] = [await fingerprint(home), await rowsOf(home)];
      expect(codeOf(await create(home, inside))).toBe('engine.not_found');
      expect(codeOf(await create(home, inside, 'a5'))).toBe('engine.not_found');
      expect(await fingerprint(home)).toBe(before);
      expect(await rowsOf(home)).toBe(rows);
    });

    it('still takes a create under a live node beside it', async () => {
      const home = await seed();
      const top = await created(home);
      await created(home, top);
      const beside = await created(home);
      await admin(`update app.nodes set deleted_at = now() where id = '${top}';`);
      const child = await created(home, beside);
      expect(await admin(`select parent_id from app.nodes where id = '${child}';`)).toBe(beside);
    });
  });

  describe('a held lock', () => {
    it('answers engine.unavailable with nothing written, and the lock is free after', async () => {
      const home = await seed();
      const [a, b] = [await created(home), await created(home)];
      const before = await fingerprint(home);
      const started = performance.now();

      const [moving, creating] = await withLockHeld(home, () =>
        Promise.all([move(home, a, b), create(home, b)]),
      );
      const waited = performance.now() - started;

      for (const refused of [moving, creating]) {
        expect(refused).toEqual({
          ok: false,
          error: { code: 'engine.unavailable', retryable: true, issues: [] },
        });
      }
      // Inside the 5 s statement timeout: it was the lock wait that answered.
      expect(waited).toBeGreaterThanOrEqual(TREE_LOCK_WAIT_MS);
      expect(waited).toBeLessThan(5000);
      expect(await fingerprint(home)).toBe(before);
      expect(codeOf(await move(home, a, b))).toBe('ok');
    });

    it('gives up on a row lock the same way, so a stuck save cannot stall the queue', async () => {
      const home = await seed();
      const [a, b] = [await created(home), await created(home)];
      const before = await fingerprint(home);
      const started = performance.now();

      const refused = await withLockHeld(
        home,
        () => move(home, a, b),
        (tx) => lockNode(tx, home.tenant, a),
      );
      const waited = performance.now() - started;

      expect(refused).toEqual({
        ok: false,
        error: { code: 'engine.unavailable', retryable: true, issues: [] },
      });
      expect(waited).toBeGreaterThanOrEqual(TREE_LOCK_WAIT_MS);
      expect(waited).toBeLessThan(5000);
      expect(await fingerprint(home)).toBe(before);
      expect(codeOf(await move(home, a, b))).toBe('ok');
    });

    it('posts an incident with a key at once, and refuses one with none when the wait ends', async () => {
      const home = await seed({ product: 'status', family: 'status_incident' });
      const incident = (orderKey?: string) =>
        engine.createNode({
          tenant: home.tenant,
          family: 'status_incident',
          typeId: home.typeId,
          ...(orderKey === undefined ? {} : { orderKey }),
        });

      const answers = await withLockHeld(home, async () => {
        const started = performance.now();
        const keyed = await incident('a5');
        const keyedMs = performance.now() - started;
        return { keyed, keyedMs, queued: await incident() };
      });

      expect(codeOf(answers.keyed)).toBe('ok');
      expect(answers.keyedMs).toBeLessThan(TREE_LOCK_WAIT_MS);
      expect(answers.queued).toEqual({
        ok: false,
        error: { code: 'engine.unavailable', retryable: true, issues: [] },
      });
    });

    it('leaves no lock wait on the connection when it goes back to the pool', async () => {
      const home = await seed();
      await created(home);
      const left = await databaseStore(db, DEFAULT_ENGINE_CONFIG).tenant(
        home.tenant,
        async (tx) => {
          await lockTree(tx, home.tenant);
          return 'done';
        },
      );
      expect(left).toBe('done');
      const after = await Promise.all(
        Array.from({ length: 10 }, () =>
          databaseStore(db, DEFAULT_ENGINE_CONFIG).tenant(home.tenant, async (tx) => {
            const { rows } = await sqlShow(tx);
            return rows[0]?.lock_timeout;
          }),
        ),
      );
      expect(new Set(after).has(`${String(TREE_LOCK_WAIT_MS)}ms`)).toBe(false);
    });

    it('keeps a second project answered while the first is queued', async () => {
      const home = await seed();
      const other = await seed({ organization: home.organization });
      const nodes = await chain(home, 3);
      const [c, d] = [await created(other), await created(other)];

      const answers = await withLockHeld(home, async () => {
        let running = true;
        const clients = Array.from({ length: 100 }, async (_, client) => {
          const seen: string[] = [];
          while (running) {
            const write =
              client % 2 === 0
                ? move(home, at(nodes, 2), at(nodes, 0))
                : create(home, at(nodes, 0));
            seen.push(codeOf(await write));
            await pause(5);
          }
          return seen;
        });
        while ((await lockWaiters()) === 0) await pause(10);

        const served: string[] = [];
        for (let turn = 0; turn < 25; turn += 1) {
          served.push(codeOf(await move(other, turn % 2 === 0 ? c : d, null)));
          await pause(100);
        }
        running = false;
        return { served, queued: await Promise.all(clients) };
      });

      expect(answers.served).toEqual(Array.from({ length: 25 }, () => 'ok'));
      expect(new Set(answers.queued.flat())).toEqual(new Set(['engine.unavailable']));
    });
  });

  // The case from the security review, with the real engine: closed loop moves on one tenant
  // with a chain far past the cap, and a neighbour on the same pool.
  describe('a tenant with a very deep chain', () => {
    it('costs a neighbour nothing', async () => {
      const home = await seed();
      const other = await seed();
      const nodes = await chain(home, 10_000);
      const loose = await created(home);
      const [c, d] = [await created(other), await created(other)];

      let running = true;
      const clients = Array.from({ length: 100 }, async (_, client) => {
        const seen: string[] = [];
        while (running) {
          const parent = client % 2 === 0 ? at(nodes, -1) : at(nodes, MAX_TREE_LEVELS - 2);
          seen.push(codeOf(await move(home, loose, parent)));
          await pause(5);
        }
        return seen;
      });

      const served: string[] = [];
      for (let turn = 0; turn < 40; turn += 1) {
        served.push(codeOf(await move(other, turn % 2 === 0 ? c : d, null)));
        await pause(100);
      }
      running = false;
      const loads = (await Promise.all(clients)).flat();

      expect(served).toEqual(Array.from({ length: 40 }, () => 'ok'));
      const allowed = new Set(['ok', 'engine.validation_failed', 'engine.unavailable']);
      expect(loads.filter((code) => !allowed.has(code))).toEqual([]);
      // The load proves nothing if the moves were all turned away, so both answers are read here.
      expect(issueOf(await move(home, loose, at(nodes, -1)))).toBe('engine.tree_too_deep');
      expect(codeOf(await move(home, loose, at(nodes, MAX_TREE_LEVELS - 2)))).toBe('ok');
    });
  });
});
