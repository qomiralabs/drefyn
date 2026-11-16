import { randomUUID } from 'node:crypto';
import {
  closeDatabase,
  withPublishedReader,
  type Database,
  type PublishedDatabase,
} from '@drefyn/db';
import { idOf, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPublishedReader,
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  publishedStore,
  storeTypes,
  type PublishedReader,
  type PublishedTx,
} from '../../src/index.ts';
import { admin, database, seed, type Seeded } from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import {
  draftNodes,
  openApp,
  openReader,
  publish,
  publishedContent,
  type NodeShape,
  type PublishedRow,
} from '../support/published.ts';
import { urlFor } from '../support/stack.ts';

const PUBLISHED = new Set(['published_versions', 'published_filter_rows']);

let app: Database;
let readerDb: PublishedDatabase;
let reader: PublishedReader;

// A bare session as the reader, with no tenant set, so a test can try what the typed
// transaction would not even let it send.
async function asReader<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor('reader', database()) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// The real path: the reader role with the tenant set by withPublishedReader.
const asTenant = <T>(seeded: Seeded, work: (tx: PublishedTx) => Promise<T>): Promise<T> =>
  withPublishedReader(readerDb, seeded.tenant, work);

const codeOf = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
};

const versionOf = (seeded: Seeded, nodeId: string, versionId?: string) =>
  reader.getPublished(
    seeded.tenant,
    idOf('nod', nodeId),
    versionId === undefined ? undefined : { versionId: idOf('ver', versionId) },
  );

describeWithStack('the published reader', () => {
  beforeAll(async () => {
    app = await openApp();
    readerDb = await openReader();
    reader = createPublishedReader({
      store: publishedStore(readerDb),
      types: storeTypes(databaseStore(app, DEFAULT_ENGINE_CONFIG)),
    });
  });

  afterAll(async () => {
    await closeDatabase(readerDb);
    await closeDatabase(app);
  });

  describe('the drefyn_public_reader role', () => {
    let a: Seeded;

    beforeAll(async () => {
      a = await seed();
      const [node] = await draftNodes(a, [{ versions: 2 }]);
      if (node === undefined) throw new Error('no node');
      await publish(a, [
        { nodeId: node.nodeId, versionId: node.versionIds[0] ?? '', current: true },
      ]);
    });

    it('gets permission denied on every table in app but the published ones', async () => {
      const tables = (
        await admin(`select tablename from pg_tables where schemaname = 'app' order by 1;`)
      ).split('\n');
      const drafts = tables.filter((name) => !PUBLISHED.has(name));
      expect(drafts).toEqual(
        expect.arrayContaining(['nodes', 'node_versions', 'node_filter_rows']),
      );
      expect(tables).toEqual(expect.arrayContaining([...PUBLISHED]));
      for (const table of drafts) {
        const code = await codeOf(
          asTenant(a, (tx) => sql`select 1 from ${sql.table(`app.${table}`)} limit 1`.execute(tx)),
        );
        expect({ table, code }).toEqual({ table, code: '42501' });
      }
    });

    it.each([
      ['insert into app.published_versions (organization_id) values ($1)'],
      ['update app.published_versions set is_current = false where organization_id = $1'],
      ['delete from app.published_versions where organization_id = $1'],
      ['insert into app.published_filter_rows (organization_id) values ($1)'],
      ['update app.published_filter_rows set t1 = null where organization_id = $1'],
      ['delete from app.published_filter_rows where organization_id = $1'],
    ])('cannot write: %s', async (statement) => {
      // Refused by grant, so no tenant is needed to show it.
      const code = await asReader((client) => codeOf(client.query(statement, [a.organization])));
      expect(code).toBe('42501');
    });

    it('sees no published row with no tenant set', async () => {
      {
        const rows = await asReader(async (client) => {
          const versions = await client.query('select 1 from app.published_versions');
          const filters = await client.query('select 1 from app.published_filter_rows');
          return versions.rows.length + filters.rows.length;
        });
        expect(rows).toBe(0);
      }
    });
  });

  describe('across tenants', () => {
    let a: Seeded;
    let sibling: Seeded;
    let other: Seeded;
    const nodes = new Map<Seeded, { nodeId: string; versionId: string }>();

    beforeAll(async () => {
      a = await seed();
      sibling = await seed({ organization: a.organization });
      other = await seed();
      for (const seeded of [a, sibling, other]) {
        const [node] = await draftNodes(seeded, [{ versions: 1 }]);
        const versionId = node?.versionIds[0] ?? '';
        if (node === undefined) throw new Error('no node');
        await publish(seeded, [{ nodeId: node.nodeId, versionId, current: true }]);
        nodes.set(seeded, { nodeId: node.nodeId, versionId });
      }
    });

    it('reads only its own project rows, at the role', async () => {
      for (const seeded of [a, sibling, other]) {
        // No where clause: the policy alone decides what comes back.
        const seen = await asTenant(seeded, async (tx) => {
          const found = await sql<{ node_id: string }>`
            select node_id from app.published_versions`.execute(tx);
          const rows = await sql<{ node_id: string }>`
            select node_id from app.published_filter_rows`.execute(tx);
          return [...found.rows, ...rows.rows].map((row) => row.node_id);
        });
        const own = nodes.get(seeded)?.nodeId;
        expect(seen).toEqual([own, own]);
      }
    });

    it('answers another tenant node and its versions as not found', async () => {
      const theirs = nodes.get(other);
      const sib = nodes.get(sibling);
      if (theirs === undefined || sib === undefined) throw new Error('no nodes');
      for (const [node, version] of [
        [theirs.nodeId, theirs.versionId],
        [sib.nodeId, sib.versionId],
      ] as const) {
        expect((await versionOf(a, node)).ok).toBe(false);
        const pinned = await versionOf(a, node, version);
        expect(pinned.ok ? null : pinned.error.code).toBe('engine.not_found');
      }
      const page = await reader.listPublished(a.tenant, { typeId: a.typeId });
      expect(page.ok && page.value.items.map((item) => item.nodeId)).toEqual([
        nodes.get(a)?.nodeId,
      ]);
      // A tenant cannot list another project's type, even by its id.
      const crossed: TenantRef = a.tenant;
      const theirsType = await reader.listPublished(crossed, { typeId: other.typeId });
      expect(theirsType.ok ? null : theirsType.error.code).toBe('engine.not_found');
    });
  });

  describe('a filtered, sorted list', () => {
    it('filters and sorts on the published slots, and pages with a cursor', async () => {
      const seeded = await seed();
      const status = randomUUID();
      const score = randomUUID();
      const schema = {
        typeId: seeded.typeId,
        apiName: 'item',
        version: 1,
        fields: [
          {
            id: status,
            apiName: 'status',
            label: 'Status',
            required: false,
            filterable: true,
            kind: 'text',
            maxLength: 32,
          },
          {
            id: score,
            apiName: 'score',
            label: 'Score',
            required: false,
            filterable: true,
            sortable: true,
            kind: 'number',
            scale: 0,
          },
        ],
        deprecated: [],
        retired: [],
      };
      const slots = {
        [status]: { column: 't1', state: 'ready' },
        [score]: { column: 'i1', state: 'ready' },
      };
      await admin(`update app.content_types set content_schema = '${JSON.stringify(schema)}',
        filter_slots = '${JSON.stringify(slots)}' where id = '${seeded.typeId}';`);
      const made = await draftNodes(
        seeded,
        Array.from({ length: 5 }, () => ({ versions: 1 })),
      );
      await publish(
        seeded,
        made.map((node, at) => ({
          nodeId: node.nodeId,
          versionId: node.versionIds[0] ?? '',
          current: true,
          slots: { t1: at === 2 ? 'held' : 'live', i1: at * 10 },
        })),
      );
      const query = {
        typeId: seeded.typeId,
        filter: { field: status, op: 'eq', value: 'live' },
        sort: { field: score, direction: 'desc' as const },
        limit: 2,
      };
      const first = await reader.listPublished(seeded.tenant, query);
      if (!first.ok) throw new Error(first.error.code);
      expect(first.value.items.map((item) => item.nodeId)).toEqual([
        made[4]?.nodeId,
        made[3]?.nodeId,
      ]);
      const cursor = first.value.nextCursor ?? '';
      const second = await reader.listPublished(seeded.tenant, { ...query, cursor });
      if (!second.ok) throw new Error(second.error.code);
      expect(second.value.items.map((item) => item.nodeId)).toEqual([
        made[1]?.nodeId,
        made[0]?.nodeId,
      ]);
      expect(second.value.nextCursor).toBeNull();
    });
  });

  describe('draft isolation', () => {
    const shape: fc.Arbitrary<
      NodeShape & { readonly published: readonly boolean[]; readonly current: number }
    > = fc
      .record({
        versions: fc.integer({ min: 0, max: 4 }),
        lifecycle: fc.constantFrom('draft', 'published', 'archived'),
        deleted: fc.boolean(),
        published: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
        current: fc.integer({ min: -1, max: 3 }),
      })
      .map((value) => ({ ...value, published: value.published.slice(0, value.versions) }));

    it('never returns a draft, by node, by pin or in a list', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(shape, { minLength: 1, maxLength: 5 }), async (shapes) => {
          const seeded = await seed();
          const made = await draftNodes(seeded, shapes);
          const rows: PublishedRow[] = [];
          const current = new Map<string, string>();
          made.forEach((node, at) => {
            const spec = shapes[at];
            if (spec === undefined) return;
            node.versionIds.forEach((versionId, index) => {
              const isCurrent = index === spec.current;
              if (!isCurrent && spec.published[index] !== true) return;
              rows.push({ nodeId: node.nodeId, versionId, current: isCurrent });
              if (isCurrent) current.set(node.nodeId, versionId);
            });
          });
          await publish(seeded, rows);
          const published = new Set(rows.map((row) => `${row.nodeId}/${row.versionId}`));

          for (const node of made) {
            const plain = await versionOf(seeded, node.nodeId);
            const expected = current.get(node.nodeId);
            if (expected === undefined) {
              expect(plain.ok ? plain.value.versionId : plain.error.code).toBe('engine.not_found');
            } else {
              expect(plain.ok && plain.value.versionId).toBe(expected);
              expect(plain.ok && plain.value.content).toEqual(publishedContent(expected));
            }
            // Every version of every node as a pin, including other nodes' versions.
            for (const other of made) {
              for (const versionId of other.versionIds) {
                const pinned = await versionOf(seeded, node.nodeId, versionId);
                const allowed = published.has(`${node.nodeId}/${versionId}`);
                expect(pinned.ok).toBe(allowed);
                if (pinned.ok) expect(pinned.value.content).toEqual(publishedContent(versionId));
              }
            }
            const guessed = await versionOf(seeded, node.nodeId, randomUUID());
            expect(guessed.ok).toBe(false);
          }

          const page = await reader.listPublished(seeded.tenant, {
            typeId: seeded.typeId,
            limit: 100,
          });
          if (!page.ok) throw new Error(page.error.code);
          expect(
            new Map(
              page.value.items.map((item) => [item.nodeId as string, item.versionId as string]),
            ),
          ).toEqual(current);
        }),
        { numRuns: 30 },
      );
    });
  });
});
