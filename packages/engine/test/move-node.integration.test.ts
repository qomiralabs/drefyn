import { randomUUID } from 'node:crypto';
import { closeDatabase, type Database } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseStore, type Engine, type EngineResult, type NodeId } from '../src/index.ts';
import { lockTree } from '../src/tree.ts';
import {
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
let built: Built;
let engine: Engine;

const created = async (
  seeded: Seeded,
  parentId: NodeId | null = null,
  orderKey?: string,
): Promise<NodeId> => {
  const made = await engine.createNode({
    tenant: seeded.tenant,
    family: 'docs_page',
    typeId: seeded.typeId,
    parentId,
    ...(orderKey === undefined ? {} : { orderKey }),
  });
  if (!made.ok) throw new Error(`createNode refused: ${made.error.code}`);
  return made.value.nodeId;
};

const move = (
  seeded: Seeded,
  nodeId: NodeId,
  parentId: NodeId | null,
  afterId: NodeId | null = null,
) => engine.moveNode({ tenant: seeded.tenant, nodeId, parentId, afterId });

const moved = async (
  seeded: Seeded,
  nodeId: NodeId,
  parentId: NodeId | null,
  afterId: NodeId | null = null,
) => {
  const result = await move(seeded, nodeId, parentId, afterId);
  if (!result.ok) throw new Error(`moveNode refused: ${result.error.code}`);
};

const nodeAt = (nodes: readonly NodeId[], at: number): NodeId => {
  const node = nodes[at];
  if (node === undefined) throw new Error(`no node at ${String(at)}`);
  return node;
};

const codeOf = (result: EngineResult<unknown>) => (result.ok ? 'ok' : result.error.code);

const children = async (seeded: Seeded, parent: NodeId | null): Promise<readonly string[]> => {
  const where = parent === null ? 'parent_id is null' : `parent_id = '${parent}'`;
  const text = await admin(
    `select id from app.nodes where project_id = '${seeded.project}' and ${where}
     order by order_key, id;`,
  );
  return text === '' ? [] : text.split('\n');
};

interface Row {
  readonly id: string;
  readonly parent: string | null;
}

const rows = async (seeded: Seeded): Promise<readonly Row[]> =>
  JSON.parse(
    await admin(`select coalesce(json_agg(json_build_object('id', id, 'parent', parent_id)), '[]')
                 from app.nodes where project_id = '${seeded.project}';`),
  ) as readonly Row[];

// Every node must reach a root. A cycle hides its members, as no root leads to them.
const expectAcyclic = (nodes: readonly Row[]) => {
  const parents = new Map(nodes.map(({ id, parent }) => [id, parent]));
  for (const { id } of nodes) {
    const seen = new Set<string>();
    let at: string | null | undefined = id;
    while (at !== null && at !== undefined) {
      expect(seen.has(at), `cycle through ${at}`).toBe(false);
      seen.add(at);
      at = parents.get(at);
    }
  }
};

// A row's xmin changes with each write, so this shows which rows a statement touched.
const stamps = (seeded: Seeded, table: string, key: string) =>
  admin(
    `select coalesce(string_agg(${key} || ':' || xmin::text, ',' order by ${key}), '')
     from app.${table} where project_id = '${seeded.project}';`,
  );

const fingerprint = (seeded: Seeded) =>
  admin(
    `select coalesce(string_agg(id || ':' || coalesce(parent_id::text, '') || ':' || order_key,
                                ',' order by id), '')
     from app.nodes where project_id = '${seeded.project}';`,
  );

const explained = (seeded: Seeded, statement: string): Promise<string> =>
  databaseStore(db).tenant(seeded.tenant, async (tx) => {
    const plan = await sql.raw<{ 'QUERY PLAN': string }>(`explain ${statement}`).execute(tx);
    return plan.rows.map((line) => line['QUERY PLAN']).join('\n');
  });

describeWithStack('moveNode against Postgres', () => {
  beforeAll(async () => {
    db = await openDatabase();
    built = buildEngine(db);
    ({ engine } = built);
  });
  afterAll(async () => {
    await closeDatabase(db);
  });

  describe('one row', () => {
    it('writes exactly one row, in nodes and nowhere else', async () => {
      const home = await seed();
      const parent = await created(home);
      const [first, second, third] = [
        await created(home, parent),
        await created(home, parent),
        await created(home),
      ];
      await save(built, home, third, null, 'Body.\n');

      const nodesBefore = (await stamps(home, 'nodes', 'id::text')).split(',');
      const filtersBefore = await stamps(home, 'node_filter_rows', 'node_id::text');
      const versionsBefore = await stamps(home, 'node_versions', 'id::text');

      await moved(home, third, parent, first);

      const nodesAfter = (await stamps(home, 'nodes', 'id::text')).split(',');
      const changed = nodesAfter.filter((stamp) => !nodesBefore.includes(stamp));
      expect(changed).toHaveLength(1);
      expect(changed[0]?.startsWith(third)).toBe(true);
      expect(await stamps(home, 'node_filter_rows', 'node_id::text')).toBe(filtersBefore);
      expect(await stamps(home, 'node_versions', 'id::text')).toBe(versionsBefore);
      expect(await children(home, parent)).toEqual([first, third, second]);
    });

    it('leaves the head and published pointers alone', async () => {
      const home = await seed();
      const node = await created(home);
      const other = await created(home);
      const { versionId } = await save(built, home, node, null, 'Body.\n');
      await admin(`update app.nodes set published_version_id = head_version_id
                   where id = '${node}';`);
      await moved(home, node, other);
      expect(
        await admin(`select head_version_id::text || ' ' || published_version_id::text
                     from app.nodes where id = '${node}';`),
      ).toBe(`${versionId} ${versionId}`);
    });
  });

  describe('position', () => {
    it('adds new siblings at the end, each with a key of its own', async () => {
      const home = await seed();
      const parent = await created(home);
      const made = [
        await created(home, parent),
        await created(home, parent),
        await created(home, parent),
      ];
      expect(await children(home, parent)).toEqual(made);
      const keys = await admin(
        `select count(distinct order_key) from app.nodes where parent_id = '${parent}';`,
      );
      expect(keys).toBe('3');
    });

    it('keeps racing creates apart', async () => {
      const home = await seed({ family: 'status_incident' });
      const make = () =>
        engine.createNode({
          tenant: home.tenant,
          family: 'status_incident',
          typeId: home.typeId,
        });
      const results = await Promise.all(Array.from({ length: 8 }, make));
      expect(results.map(codeOf)).toEqual(Array.from({ length: 8 }, () => 'ok'));
      expect(
        await admin(
          `select count(distinct order_key) from app.nodes where project_id = '${home.project}';`,
        ),
      ).toBe('8');
    });

    it('moves between siblings, to the front, to the end and across parents', async () => {
      const home = await seed();
      const [a, b, c] = [await created(home), await created(home), await created(home)];
      await moved(home, c, null, a);
      expect(await children(home, null)).toEqual([a, c, b]);
      await moved(home, b, null);
      expect(await children(home, null)).toEqual([b, a, c]);
      await moved(home, b, null, c);
      expect(await children(home, null)).toEqual([a, c, b]);
      await moved(home, c, a);
      expect(await children(home, null)).toEqual([a, b]);
      expect(await children(home, a)).toEqual([c]);
      await moved(home, c, null, a);
      expect(await children(home, null)).toEqual([a, c, b]);
    });

    it('stays in order when one spot is used again and again', async () => {
      const home = await seed();
      const [a, b] = [await created(home), await created(home)];
      const spare = [await created(home, a), await created(home, a), await created(home, a)];
      for (const node of [...spare, ...spare, ...spare]) await moved(home, node, null, a);
      expect(await children(home, null)).toEqual([a, ...[...spare].reverse(), b]);
    });

    it('is a move when the node is already there', async () => {
      const home = await seed();
      const [a, b] = [await created(home), await created(home)];
      await moved(home, b, null, a);
      expect(await children(home, null)).toEqual([a, b]);
    });

    it('sorts by bytes whatever the database locale', async () => {
      const home = await seed();
      const parent = await created(home);
      const keys = ['a0', 'Zz', 'a1', 'b00', 'az', 'aA'];
      const made = new Map<string, NodeId>();
      for (const key of keys) made.set(key, await created(home, parent, key));
      const sorted = ['Zz', 'a0', 'a1', 'aA', 'az', 'b00'];
      expect(await children(home, parent)).toEqual(sorted.map((key) => made.get(key)));
    });
  });

  describe('cycles', () => {
    it('refuses a node as its own parent', async () => {
      const home = await seed();
      const node = await created(home);
      const before = await fingerprint(home);
      expect(await move(home, node, node)).toMatchObject({
        ok: false,
        error: {
          code: 'engine.validation_failed',
          issues: [{ path: 'parentId', code: 'engine.cycle' }],
        },
      });
      expect(await fingerprint(home)).toBe(before);
    });

    it('refuses a move under its own child and under a deep descendant', async () => {
      const home = await seed();
      const top = await created(home);
      const child = await created(home, top);
      let deep = child;
      for (let depth = 0; depth < 30; depth += 1) deep = await created(home, deep);
      const before = await fingerprint(home);
      for (const target of [child, deep]) {
        expect(await move(home, top, target)).toMatchObject({
          ok: false,
          error: { issues: [{ path: 'parentId', code: 'engine.cycle' }] },
        });
      }
      expect(await fingerprint(home)).toBe(before);
    });

    it('moves a subtree whole, and allows what looks like a cycle but is not', async () => {
      const home = await seed();
      const [a, b] = [await created(home), await created(home)];
      const leaf = await created(home, a);
      await moved(home, a, b);
      expect(await children(home, b)).toEqual([a]);
      expect(await children(home, a)).toEqual([leaf]);
      // Up and over its old parent: not a cycle, though the same pair just moved the other way.
      await moved(home, b, null);
      await moved(home, leaf, null);
      await moved(home, b, leaf);
      expect(await children(home, leaf)).toEqual([b]);
    });

    it('ends its walk on a cycle already in the data', async () => {
      const home = await seed();
      const [a, b, loose] = [await created(home), await created(home), await created(home)];
      await admin(`update app.nodes set parent_id = '${b}' where id = '${a}';
                   update app.nodes set parent_id = '${a}' where id = '${b}';`);
      expect(await move(home, loose, a)).toMatchObject({ ok: true });
    });
  });

  describe('racing moves', () => {
    it('lets one of two opposite moves win, every time', async () => {
      const home = await seed();
      for (let round = 0; round < 40; round += 1) {
        const [a, b] = [await created(home), await created(home)];
        const results = await Promise.all([move(home, a, b), move(home, b, a)]);
        const codes = results.map(codeOf).sort();
        expect(codes).toEqual(['engine.validation_failed', 'ok']);
        const refused = results.find((result) => !result.ok);
        expect(refused).toMatchObject({ error: { issues: [{ code: 'engine.cycle' }] } });
      }
      expectAcyclic(await rows(home));
    });

    it('leaves every node reachable from a root, whatever races', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.tuple(fc.nat({ max: 7 }), fc.nat({ max: 8 })), {
            minLength: 2,
            maxLength: 12,
          }),
          async (moves) => {
            const home = await seed();
            const nodes: NodeId[] = [];
            for (let at = 0; at < 8; at += 1) nodes.push(await created(home));
            const results = await Promise.all(
              moves.map(([node, parent]) => move(home, nodeAt(nodes, node), nodes[parent] ?? null)),
            );
            for (const result of results) {
              if (result.ok) continue;
              expect(result.error.issues).toMatchObject([{ code: 'engine.cycle' }]);
            }
            expectAcyclic(await rows(home));
          },
        ),
        { numRuns: 20 },
      );
    });

    it('gives racing inserts at one spot keys of their own', async () => {
      const home = await seed();
      const [a, b] = [await created(home), await created(home)];
      const spare = [] as NodeId[];
      for (let at = 0; at < 10; at += 1) spare.push(await created(home, a));
      const results = await Promise.all(spare.map((node) => move(home, node, null, a)));
      expect(results.map(codeOf)).toEqual(spare.map(() => 'ok'));
      const list = await children(home, null);
      expect(new Set(list).size).toBe(12);
      expect(list[0]).toBe(a);
      expect(list.at(-1)).toBe(b);
      expect(
        await admin(
          `select count(distinct order_key) from app.nodes
           where project_id = '${home.project}' and parent_id is null;`,
        ),
      ).toBe('12');
    });

    it('does not fight a save on the same node', async () => {
      const home = await seed();
      const [node, parent] = [await created(home), await created(home)];
      const [saved, movedResult] = await Promise.all([
        save(built, home, node, null, 'Body.\n'),
        move(home, node, parent),
      ]);
      expect(codeOf(movedResult)).toBe('ok');
      expect(await children(home, parent)).toEqual([node]);
      expect(await admin(`select head_version_id from app.nodes where id = '${node}';`)).toBe(
        saved.versionId,
      );
    });

    it('waits for the project lock, and another project does not', async () => {
      const home = await seed();
      const other = await seed({ organization: home.organization });
      const [a, b] = [await created(home), await created(home)];
      const [c, d] = [await created(other), await created(other)];

      let release: () => void = () => undefined;
      const held = new Promise<void>((done) => {
        release = done;
      });
      let locked: () => void = () => undefined;
      const taken = new Promise<void>((done) => {
        locked = done;
      });
      const holder = databaseStore(db).tenant(home.tenant, async (tx) => {
        await lockTree(tx, home.tenant);
        locked();
        await held;
      });
      await taken;

      let finished = false;
      const waiting = move(home, a, b).then((result) => {
        finished = true;
        return result;
      });
      // The other project's move finishing first shows both that it was free to run and that
      // the blocked one had time to.
      expect(codeOf(await move(other, c, d))).toBe('ok');
      expect(finished).toBe(false);
      release();
      await holder;
      expect(codeOf(await waiting)).toBe('ok');
    });
  });

  describe('tenants', () => {
    const elsewhere = async (home: Seeded) => {
      const organization = await seed();
      const project = await seed({ organization: home.organization });
      return [
        ['another organization', organization],
        ['another project of this organization', project],
      ] as const;
    };

    it('answers the same for another tenant as for an id that never existed', async () => {
      const home = await seed();
      const [node, sibling] = [await created(home), await created(home)];
      const never = idOf('nod', randomUUID());
      const before = await fingerprint(home);
      const answer = await move(home, never, null);
      expect(answer).toEqual({
        ok: false,
        error: { code: 'engine.not_found', retryable: false, issues: [] },
      });
      expect(await move(home, node, never)).toEqual(answer);
      expect(await move(home, node, null, never)).toEqual(answer);

      for (const [name, tenant] of await elsewhere(home)) {
        const theirs = await created(tenant);
        const theirBefore = await fingerprint(tenant);
        const asked = [
          await move(home, theirs, null),
          await move(home, theirs, node),
          await move(home, node, theirs),
          await move(home, node, null, theirs),
          await move(home, sibling, theirs, node),
          await move(tenant, node, null),
          await move(tenant, theirs, node),
        ];
        for (const result of asked) expect(result, name).toEqual(answer);
        expect(await fingerprint(tenant)).toBe(theirBefore);
      }
      expect(await fingerprint(home)).toBe(before);
    });

    it('never crosses a project when a walk reaches a foreign parent', async () => {
      const home = await seed();
      const other = await seed({ organization: home.organization });
      const [mine, theirs] = [await created(home), await created(other)];
      await expect(
        admin(`update app.nodes set parent_id = '${theirs}' where id = '${mine}';`),
      ).rejects.toThrow(/nodes_parent_fkey/);
    });
  });

  describe('pairs inside a project', () => {
    it('refuses an anchor that is a child of another parent', async () => {
      const home = await seed();
      const [left, right, node] = [await created(home), await created(home), await created(home)];
      const leftChild = await created(home, left);
      const before = await fingerprint(home);
      expect(codeOf(await move(home, node, right, leftChild))).toBe('engine.not_found');
      expect(codeOf(await move(home, node, null, leftChild))).toBe('engine.not_found');
      expect(codeOf(await move(home, node, left, right))).toBe('engine.not_found');
      expect(await fingerprint(home)).toBe(before);
    });

    it.each([
      ['the node', 'node'],
      ['the parent', 'parent'],
      ['an ancestor of the parent', 'ancestor'],
      ['the anchor', 'anchor'],
    ])('answers not found when %s is deleted', async (_name, which) => {
      const home = await seed();
      const ancestor = await created(home);
      const parent = await created(home, ancestor);
      const anchor = await created(home, parent);
      const node = await created(home);
      const target = { node, parent, ancestor, anchor }[which];
      await admin(`update app.nodes set deleted_at = now() where id = '${String(target)}';`);
      expect(codeOf(await move(home, node, parent, anchor))).toBe('engine.not_found');
    });

    it('skips deleted siblings when it finds the gap', async () => {
      const home = await seed();
      const [a, gone, b, node] = [
        await created(home),
        await created(home),
        await created(home),
        await created(home),
      ];
      await admin(`update app.nodes set deleted_at = now() where id = '${gone}';`);
      await moved(home, node, null, a);
      const live = (await children(home, null)).filter((id) => id !== gone);
      expect(live).toEqual([a, node, b]);
    });
  });

  describe('limits', () => {
    it('refuses a move in a project that is read only', async () => {
      const home = await seed();
      const [a, b] = [await created(home), await created(home)];
      await admin(`update app.projects set read_only_since = now() where id = '${home.project}';`);
      const before = await fingerprint(home);
      expect(codeOf(await move(home, a, b))).toBe('engine.read_only');
      expect(await fingerprint(home)).toBe(before);
    });

    it('refuses a tie, and a gap too narrow to use', async () => {
      const home = await seed();
      const [a, b, node] = [
        await created(home, null, 'a5'),
        await created(home, null, 'a5'),
        await created(home, null, 'a7'),
      ];
      const [first, second] = a < b ? [a, b] : [b, a];
      expect(await move(home, node, null, first)).toMatchObject({
        ok: false,
        error: { issues: [{ path: 'afterId', code: 'engine.order_key_no_room' }] },
      });
      expect(codeOf(await move(home, node, null, second))).toBe('ok');
    });

    it('refuses a key past the cap with a stable code', async () => {
      const home = await seed();
      const long = `a0${'V'.repeat(1100)}`;
      const [a, b, node] = [await created(home), await created(home), await created(home)];
      await admin(`update app.nodes set order_key = '${long}1' where id = '${a}';
                   update app.nodes set order_key = '${long}2' where id = '${b}';`);
      expect(codeOf(await move(home, node, null, a))).toBe('engine.too_large');
    });
  });

  describe('plans', () => {
    it('lists roots through the partial index and children through their own', async () => {
      const home = await seed();
      const parent = await created(home);
      await admin(`
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle, parent_id)
  select '${home.organization}', '${home.project}', 'docs_page', '${home.typeId}',
         'a' || lpad(i::text, 6, '0'), 'draft', case when i % 2 = 0 then null else '${parent}'::uuid end
  from generate_series(1, 4000) i;
analyze app.nodes;`);
      const scope = `organization_id = '${home.organization}' and project_id = '${home.project}'`;
      const roots = await explained(
        home,
        `select id from app.nodes where ${scope} and parent_id is null and deleted_at is null
         order by order_key limit 50`,
      );
      expect(roots).toMatch(/Index Scan using nodes_roots/);
      expect(roots).not.toMatch(/Sort/);
      const list = await explained(
        home,
        `select id from app.nodes where ${scope} and parent_id = '${parent}'
           and deleted_at is null order by order_key limit 50`,
      );
      expect(list).toMatch(/Index Scan using nodes_children/);
      expect(list).not.toMatch(/Sort/);
    });
  });
});
