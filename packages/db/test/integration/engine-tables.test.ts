import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALLOW_LISTS } from '../../src/allow-lists.ts';
import { withTenant } from '../../src/index.ts';
import { describeFailure, migrate, shippedMigrations } from './support/cli.ts';
import { databases, type TestDatabase } from './support/databases.ts';
import { describeWithStack } from './support/presence.ts';
import { superuser, type Role } from './support/stack.ts';
import { catalogProblems, pools, rawSession } from './support/tenancy.ts';

const dbs = databases();
const openPools = pools();

const id = (n: number) => `01a14984-4476-77ce-9335-13${String(n).padStart(10, '0')}`;
const hash = (byte: string) => Buffer.from(byte.repeat(32), 'hex');
const hashSql = (byte: string) => `decode(repeat('${byte}', 32), 'hex')`;

interface Tenant {
  readonly org: string;
  readonly project: string;
  readonly type: string;
  readonly node: string;
  // Has no filter row, so a test can write one.
  readonly spareNode: string;
  readonly version: string;
  readonly chunk: string;
  readonly embedding: string;
  readonly outbox: string;
}

function tenant(org: number, project: number, base: number): Tenant {
  return {
    org: id(org),
    project: id(project),
    type: id(base + 1),
    node: id(base + 2),
    spareNode: id(base + 3),
    version: id(base + 4),
    chunk: id(base + 5),
    embedding: id(base + 6),
    outbox: id(base + 7),
  };
}

const A = tenant(1, 11, 100);
// Same organization as A, another project.
const A2 = tenant(1, 12, 200);
const B = tenant(2, 21, 300);
const ALL = [A, A2, B];

const tenantRows = (t: Tenant) => `
insert into app.content_types (id, organization_id, project_id, family, key)
  values ('${t.type}', '${t.org}', '${t.project}', 'studio_item', 'article');
insert into app.nodes (id, organization_id, project_id, family, type_id, order_key, lifecycle)
  values ('${t.node}', '${t.org}', '${t.project}', 'studio_item', '${t.type}', 'a0', 'draft'),
         ('${t.spareNode}', '${t.org}', '${t.project}', 'studio_item', '${t.type}', 'a1', 'draft');
insert into app.node_versions (id, organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256, idempotency_key)
  values ('${t.version}', '${t.org}', '${t.project}', '${t.node}', 1, 1, 1, 'human', '{}', '{}',
          ${hashSql('aa')}, 'first-save');
insert into app.node_filter_rows (organization_id, project_id, type_id, node_id, t1)
  values ('${t.org}', '${t.project}', '${t.type}', '${t.node}', 'one');
insert into app.chunks (id, organization_id, project_id, node_id, version_id, ord, block_path,
    heading_path, body, body_sha256)
  values ('${t.chunk}', '${t.org}', '${t.project}', '${t.node}', '${t.version}', 0, '0', '{}',
          'body', ${hashSql('bb')});
insert into app.chunk_embeddings (id, organization_id, project_id, body_sha256, model_id, embedding)
  values ('${t.embedding}', '${t.org}', '${t.project}', ${hashSql('bb')}, 'model-1', '[1,0,0]');
insert into app.engine_outbox (id, organization_id, project_id, node_id, version_id, kind)
  values ('${t.outbox}', '${t.org}', '${t.project}', '${t.node}', '${t.version}', 'embed');`;

const seedSql = `
insert into app.organizations (organization_id, name, plan_tier)
  values ('${A.org}', 'A', 'self_hosted'), ('${B.org}', 'B', 'self_hosted');
insert into app.projects (id, organization_id, product, slug, name)
  values ('${A.project}', '${A.org}', 'docs', 'one', 'One'),
         ('${A2.project}', '${A2.org}', 'docs', 'two', 'Two'),
         ('${B.project}', '${B.org}', 'docs', 'one', 'One');
${ALL.map(tenantRows).join('\n')}`;

interface Insert {
  readonly text: string;
  readonly values: readonly unknown[];
}

// Every value that decides the row's tenant or its parent is a parameter, so one builder
// covers the honest write and each refused one.
const insertType = (org: string, project: string): Insert => ({
  text: `insert into app.content_types (organization_id, project_id, family, key)
         values ($1, $2, 'studio_item', 'fresh')`,
  values: [org, project],
});

const insertNode = (
  org: string,
  project: string,
  over: {
    readonly type?: string;
    readonly parent?: string | null;
    readonly head?: string | null;
    readonly published?: string | null;
    readonly family?: string;
    readonly lifecycle?: string;
  } = {},
  t: Tenant = A,
): Insert => ({
  text: `insert into app.nodes (organization_id, project_id, family, type_id, parent_id,
           order_key, head_version_id, published_version_id, lifecycle)
         values ($1, $2, $3, $4, $5, 'b0', $6, $7, $8)`,
  values: [
    org,
    project,
    over.family ?? 'studio_item',
    over.type ?? t.type,
    over.parent ?? null,
    over.head ?? null,
    over.published ?? null,
    over.lifecycle ?? 'draft',
  ],
});

// A version only ever belongs to a node that already exists, so these are updates.
const pointNode = (column: string, version: string, node: string): Insert => ({
  text: `update app.nodes set ${column} = $1 where id = $2`,
  values: [version, node],
});

const insertVersion = (
  org: string,
  project: string,
  over: {
    readonly node?: string;
    readonly seq?: number;
    readonly parent?: string | null;
    readonly origin?: string;
    readonly key?: string | null;
    readonly sha?: Buffer;
  } = {},
  t: Tenant = A,
): Insert => ({
  text: `insert into app.node_versions (organization_id, project_id, node_id, seq, parent_version_id,
           schema_version, ast_version, origin, actor, content, content_sha256, idempotency_key)
         values ($1, $2, $3, $4, $5, 1, 1, $6, '{}', '{}', $7, $8)`,
  values: [
    org,
    project,
    over.node ?? t.node,
    over.seq ?? 2,
    over.parent ?? null,
    over.origin ?? 'human',
    over.sha ?? hash('cc'),
    over.key ?? null,
  ],
});

const insertFilterRow = (
  org: string,
  project: string,
  over: { readonly type?: string; readonly node?: string } = {},
  t: Tenant = A,
): Insert => ({
  text: `insert into app.node_filter_rows (organization_id, project_id, type_id, node_id)
         values ($1, $2, $3, $4)`,
  values: [org, project, over.type ?? t.type, over.node ?? t.spareNode],
});

const insertChunk = (
  org: string,
  project: string,
  over: { readonly node?: string; readonly version?: string } = {},
  t: Tenant = A,
): Insert => ({
  text: `insert into app.chunks (organization_id, project_id, node_id, version_id, ord, block_path,
           heading_path, body, body_sha256)
         values ($1, $2, $3, $4, 1, '1', '{}', 'text', $5)`,
  values: [org, project, over.node ?? t.node, over.version ?? t.version, hash('dd')],
});

const insertEmbedding = (
  org: string,
  project: string,
  over: { readonly sha?: Buffer; readonly model?: string } = {},
): Insert => ({
  text: `insert into app.chunk_embeddings (organization_id, project_id, body_sha256, model_id, embedding)
         values ($1, $2, $3, $4, '[0,1,0]')`,
  values: [org, project, over.sha ?? hash('dd'), over.model ?? 'model-2'],
});

const insertOutbox = (
  org: string,
  project: string,
  over: { readonly node?: string; readonly version?: string } = {},
  t: Tenant = A,
): Insert => ({
  text: `insert into app.engine_outbox (organization_id, project_id, node_id, version_id, kind)
         values ($1, $2, $3, $4, 'embed')`,
  values: [org, project, over.node ?? t.node, over.version ?? t.version],
});

interface EngineTable {
  readonly table: string;
  // The row's key column and its value for a tenant.
  readonly key: string;
  readonly keyOf: (t: Tenant) => string;
  // A write to one ordinary column.
  readonly touch: string;
  // A new valid row for A, naming whatever organization and project it is given.
  readonly insert: (org: string, project: string) => Insert;
}

const TABLES: readonly EngineTable[] = [
  {
    table: 'content_types',
    key: 'id',
    keyOf: (t) => t.type,
    touch: 'current_schema_version = 2',
    insert: insertType,
  },
  {
    table: 'nodes',
    key: 'id',
    keyOf: (t) => t.node,
    touch: `lifecycle = 'archived'`,
    insert: insertNode,
  },
  {
    table: 'node_versions',
    key: 'id',
    keyOf: (t) => t.version,
    touch: 'ast_version = 2',
    insert: insertVersion,
  },
  {
    table: 'node_filter_rows',
    key: 'node_id',
    keyOf: (t) => t.node,
    touch: `t1 = 'two'`,
    insert: insertFilterRow,
  },
  {
    table: 'chunks',
    key: 'id',
    keyOf: (t) => t.chunk,
    touch: `body = 'changed'`,
    insert: insertChunk,
  },
  {
    table: 'chunk_embeddings',
    key: 'id',
    keyOf: (t) => t.embedding,
    touch: `model_id = 'model-9'`,
    insert: insertEmbedding,
  },
  {
    table: 'engine_outbox',
    key: 'id',
    keyOf: (t) => t.outbox,
    touch: 'done_at = now()',
    insert: insertOutbox,
  },
];

const TABLE_NAMES = TABLES.map((t) => t.table);

// History is append only, so drefyn_app holds no update or delete on it.
const REWRITABLE = TABLES.filter((t) => t.table !== 'node_versions');

// Each child, the foreign key that guards it, and a write that names a parent. `of` is the
// tenant the parent ids come from; the row itself always belongs to A.
interface ForeignKey {
  readonly constraint: string;
  readonly write: (of: Tenant, missing?: string) => Insert;
}

const FOREIGN_KEYS: readonly ForeignKey[] = [
  {
    constraint: 'nodes_type_fkey',
    write: (of, missing) => insertNode(A.org, A.project, { type: missing ?? of.type }),
  },
  {
    constraint: 'nodes_parent_fkey',
    write: (of, missing) => insertNode(A.org, A.project, { parent: missing ?? of.node }),
  },
  {
    constraint: 'nodes_head_version_fkey',
    write: (of, missing) => pointNode('head_version_id', missing ?? of.version, A.node),
  },
  {
    constraint: 'nodes_published_version_fkey',
    write: (of, missing) => pointNode('published_version_id', missing ?? of.version, A.node),
  },
  {
    constraint: 'node_versions_node_fkey',
    write: (of, missing) => insertVersion(A.org, A.project, { node: missing ?? of.node }),
  },
  {
    constraint: 'node_versions_parent_version_fkey',
    write: (of, missing) => insertVersion(A.org, A.project, { parent: missing ?? of.version }),
  },
  {
    constraint: 'node_filter_rows_node_fkey',
    write: (of, missing) => insertFilterRow(A.org, A.project, { node: missing ?? of.spareNode }),
  },
  {
    constraint: 'chunks_version_fkey',
    write: (of, missing) => insertChunk(A.org, A.project, { version: missing ?? of.version }),
  },
  {
    constraint: 'engine_outbox_version_fkey',
    write: (of, missing) => insertOutbox(A.org, A.project, { version: missing ?? of.version }),
  },
];

let db: TestDatabase;
const sessions = new Map<Role, pg.Client>();

// One session per role for the whole file, reused by every case: each case rolls back, and
// other files run beside this one.
async function session(role: Role, database = db.name): Promise<pg.Client> {
  if (database !== db.name) return rawSession(role, database);
  const open = sessions.get(role);
  if (open !== undefined) return open;
  const client = await rawSession(role, database);
  client.on('error', () => undefined);
  sessions.set(role, client);
  return client;
}

afterAll(async () => {
  for (const client of sessions.values()) await client.end().catch(() => undefined);
  sessions.clear();
});

// One transaction with the given settings, rolled back, so each case starts from the seed.
async function within<T>(
  org: string,
  project: string,
  work: (client: pg.Client) => Promise<T>,
  role: Role = 'app',
): Promise<T> {
  const client = await session(role);
  await client.query('begin');
  try {
    await client.query("select set_config('drefyn.organization_id', $1, true)", [org]);
    await client.query("select set_config('drefyn.project_id', $1, true)", [project]);
    return await work(client);
  } finally {
    await client.query('rollback');
  }
}

const as = <T>(t: Tenant, work: (client: pg.Client) => Promise<T>) =>
  within(t.org, t.project, work);

const run = (client: pg.Client, write: Insert) => client.query(write.text, [...write.values]);

interface Refusal {
  readonly code: string | undefined;
  readonly constraint: string | undefined;
  readonly detail: string | undefined;
}

async function refusal(work: Promise<unknown>): Promise<Refusal> {
  try {
    await work;
  } catch (error) {
    const { code, constraint, detail } = error as pg.DatabaseError;
    return { code, constraint, detail };
  }
  throw new Error('the database accepted the write');
}

const firstId = (result: pg.QueryResult<{ id: string }>) => {
  const row = result.rows[0];
  if (row === undefined) throw new Error('the insert returned no row');
  return row.id;
};

const keys = async (client: pg.Client, spec: EngineTable): Promise<readonly string[]> => {
  const result = await client.query<{ key: string }>(
    `select ${spec.key}::text as key from app.${spec.table} order by 1`,
  );
  return result.rows.map((row) => row.key);
};

// The seed gives a table this tenant's rows, and only this tenant's rows: one, or two for
// the node table, where a spare exists for filter row writes.
const seeded = (spec: EngineTable, t: Tenant) =>
  spec.table === 'nodes' ? [t.node, t.spareNode].sort() : [spec.keyOf(t)];

const count = async (client: pg.Client, table: string): Promise<number> => {
  const result = await client.query<{ n: string }>(`select count(*)::int8 as n from app.${table}`);
  return Number(result.rows[0]?.n);
};

const NAMES_LIST = TABLE_NAMES.map((t) => `'app.${t}'::regclass`).join(', ');

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Index Name'?: string;
  readonly 'Index Cond'?: string;
  readonly 'Heap Fetches'?: number;
  readonly Plans?: readonly PlanNode[];
}

const flatten = (node: PlanNode): readonly PlanNode[] => [
  node,
  ...(node.Plans ?? []).flatMap(flatten),
];

describeWithStack('the engine tables', () => {
  beforeAll(async () => {
    db = await dbs.fresh('migrated');
    await superuser(seedSql, db.name);
  });

  describe('reads between tenants', () => {
    it.each(TABLES)('$table shows a tenant its own rows and no others', async (spec) => {
      expect(await as(A, (client) => keys(client, spec))).toEqual(seeded(spec, A));
      expect(await as(B, (client) => keys(client, spec))).toEqual(seeded(spec, B));
    });

    it.each(TABLES)('$table hides one project from another in its organization', async (spec) => {
      expect(await as(A2, (client) => keys(client, spec))).toEqual(seeded(spec, A2));
    });

    it.each(TABLES)('$table finds no other tenant row by its key', async (spec) => {
      const found = await as(B, (client) =>
        client.query(`select 1 from app.${spec.table} where ${spec.key} = $1`, [spec.keyOf(A)]),
      );
      expect(found.rowCount).toBe(0);
    });

    it.each(TABLES)('$table reads as empty with no project set', async (spec) => {
      expect(await within(A.org, '', (client) => keys(client, spec))).toEqual([]);
    });

    it.each(TABLES)('$table reads as empty with no tenant set', async (spec) => {
      expect(await within('', '', (client) => keys(client, spec))).toEqual([]);
    });

    it.each(TABLES)('$table reads as empty when project belongs to another org', async (spec) => {
      expect(await within(A.org, B.project, (client) => keys(client, spec))).toEqual([]);
    });

    it('holds through withTenant, the path product code takes', async () => {
      const pool = await openPools.app(db.app);
      const ref = (t: Tenant): TenantRef => ({
        organizationId: organizationId(t.org),
        projectId: projectId(t.project),
      });
      const read = (t: Tenant) =>
        withTenant(pool, ref(t), (tx) =>
          tx.selectFrom('nodes').select('id').orderBy('id').execute(),
        );
      expect((await read(A)).map((row) => row.id)).toEqual([A.node, A.spareNode].sort());
      expect((await read(B)).map((row) => row.id)).toEqual([B.node, B.spareNode].sort());
    });
  });

  describe('writes between tenants', () => {
    it.each(TABLES)('$table takes a write inside the tenant', async (spec) => {
      const done = await as(A, (client) => run(client, spec.insert(A.org, A.project)));
      expect(done.rowCount).toBe(1);
    });

    it.each(TABLES)('$table refuses a row naming another organization', async (spec) => {
      const refused = await as(B, (client) => refusal(run(client, spec.insert(A.org, A.project))));
      expect(refused.code).toBe('42501');
    });

    it.each(TABLES)('$table refuses a row naming another project', async (spec) => {
      const refused = await as(A2, (client) => refusal(run(client, spec.insert(A.org, A.project))));
      expect(refused.code).toBe('42501');
    });

    it.each(TABLES)('$table refuses any insert with no project set', async (spec) => {
      const refused = await within(A.org, '', (client) =>
        refusal(run(client, spec.insert(A.org, A.project))),
      );
      expect(refused.code).toBe('42501');
    });

    it.each(REWRITABLE)('$table updates no other tenant row', async (spec) => {
      const done = await as(B, (client) =>
        client.query(`update app.${spec.table} set ${spec.touch} where ${spec.key} = $1`, [
          spec.keyOf(A),
        ]),
      );
      expect(done.rowCount).toBe(0);
    });

    it.each(REWRITABLE)('$table updates a row of its own', async (spec) => {
      const done = await as(A, (client) =>
        client.query(`update app.${spec.table} set ${spec.touch} where ${spec.key} = $1`, [
          spec.keyOf(A),
        ]),
      );
      expect(done.rowCount).toBe(1);
    });

    it.each(REWRITABLE)('$table deletes no other tenant row', async (spec) => {
      const done = await as(B, (client) =>
        client.query(`delete from app.${spec.table} where ${spec.key} = $1`, [spec.keyOf(A)]),
      );
      expect(done.rowCount).toBe(0);
    });

    it.each(TABLES)('$table cannot give a row to another organization', async (spec) => {
      const refused = await as(A, (client) =>
        refusal(
          client.query(`update app.${spec.table} set organization_id = $1 where ${spec.key} = $2`, [
            B.org,
            spec.keyOf(A),
          ]),
        ),
      );
      expect(refused.code).toBe('42501');
    });

    it.each(TABLES)('$table cannot give a row to another project', async (spec) => {
      const refused = await as(A, (client) =>
        refusal(
          client.query(`update app.${spec.table} set project_id = $1 where ${spec.key} = $2`, [
            A2.project,
            spec.keyOf(A),
          ]),
        ),
      );
      expect(refused.code).toBe('42501');
    });
  });

  describe('foreign keys between tenants', () => {
    it('has a case for every foreign key on the seven tables', async () => {
      const found = await superuser(
        `select conname from pg_constraint
          where contype = 'f' and conrelid in (${TABLE_NAMES.map((t) => `'app.${t}'::regclass`).join(', ')})
          order by 1;`,
        db.name,
      );
      const projectKeys = TABLE_NAMES.map((t) => `${t}_project_fkey`);
      expect(found.trim().split('\n')).toEqual(
        [...FOREIGN_KEYS.map((key) => key.constraint), ...projectKeys].sort(),
      );
    });

    it('carries organization and project on every foreign key', async () => {
      const short = await superuser(
        `select conname from pg_constraint c
          where contype = 'f' and conrelid in (${TABLE_NAMES.map((t) => `'app.${t}'::regclass`).join(', ')})
            and not (conkey[1:2] = (
              select array_agg(a.attnum order by a.attname)
                from pg_attribute a where a.attrelid = c.conrelid
                 and a.attname in ('organization_id', 'project_id')));`,
        db.name,
      );
      expect(short.trim()).toBe('');
    });

    it.each(FOREIGN_KEYS)('$constraint accepts a parent of the tenant', async ({ write }) => {
      const done = await as(A, (client) => run(client, write(A)));
      expect(done.rowCount).toBe(1);
    });

    it.each(FOREIGN_KEYS)(
      '$constraint refuses a parent in another organization',
      async ({ constraint, write }) => {
        const refused = await as(A, (client) => refusal(run(client, write(B))));
        expect(refused).toMatchObject({ code: '23503', constraint });
      },
    );

    it.each(FOREIGN_KEYS)(
      '$constraint refuses a parent in another project of the organization',
      async ({ constraint, write }) => {
        const refused = await as(A, (client) => refusal(run(client, write(A2))));
        expect(refused).toMatchObject({ code: '23503', constraint });
      },
    );

    // A refusal that read differently for a real id would let a tenant probe for others' rows.
    it.each(FOREIGN_KEYS)(
      '$constraint says the same for another tenant id and one that never existed',
      async ({ write }) => {
        const missing = id(999);
        const held = await as(A, (client) => refusal(run(client, write(B))));
        const none = await as(A, (client) => refusal(run(client, write(B, missing))));
        const given = write(B).values.find((value) =>
          Object.values(B).includes(value as string),
        ) as string;
        expect(none.code).toBe(held.code);
        expect(none.constraint).toBe(held.constraint);
        expect(none.detail).toBe(held.detail?.replaceAll(given, missing));
      },
    );

    it.each(TABLES)('$table_project_fkey refuses a project of another org', async (spec) => {
      // The settings name a project of another organization, so the policy alone would pass.
      const write = spec.insert(A.org, B.project);
      const refused = await within(A.org, B.project, (client) => refusal(run(client, write)));
      expect(refused.code).toBe('23503');
    });
  });

  describe('parent pairs inside one project', () => {
    const insertOtherVersion = (client: pg.Client) =>
      client.query<{ id: string }>(
        `insert into app.node_versions (organization_id, project_id, node_id, seq, schema_version,
           ast_version, origin, actor, content, content_sha256)
         values ($1, $2, $3, 1, 1, 1, 'human', '{}', '{}', $4) returning id`,
        [A.org, A.project, A.spareNode, hash('ee')],
      );

    it.each(['head_version_id', 'published_version_id'])(
      '%s refuses a version of another node',
      async (column) => {
        const refused = await as(A, (client) =>
          refusal(run(client, pointNode(column, A.version, A.spareNode))),
        );
        expect(refused).toMatchObject({
          code: '23503',
          constraint: `nodes_${column.replace('_id', '')}_fkey`,
        });
      },
    );

    it('a version refuses a parent version of another node', async () => {
      const refused = await as(A, async (client) => {
        const other = await insertOtherVersion(client);
        return refusal(run(client, insertVersion(A.org, A.project, { parent: firstId(other) })));
      });
      expect(refused).toMatchObject({
        code: '23503',
        constraint: 'node_versions_parent_version_fkey',
      });
    });

    it('a chunk refuses a version of another node', async () => {
      const refused = await as(A, (client) =>
        refusal(run(client, insertChunk(A.org, A.project, { node: A.spareNode }))),
      );
      expect(refused).toMatchObject({ code: '23503', constraint: 'chunks_version_fkey' });
    });

    it('an outbox row refuses a version of another node', async () => {
      const refused = await as(A, (client) =>
        refusal(run(client, insertOutbox(A.org, A.project, { node: A.spareNode }))),
      );
      expect(refused).toMatchObject({ code: '23503', constraint: 'engine_outbox_version_fkey' });
    });

    it('a filter row refuses a type its node does not have', async () => {
      const refused = await as(A, async (client) => {
        const other = await client.query<{ id: string }>(
          `insert into app.content_types (organization_id, project_id, family, key)
           values ($1, $2, 'studio_item', 'other') returning id`,
          [A.org, A.project],
        );
        return refusal(run(client, insertFilterRow(A.org, A.project, { type: firstId(other) })));
      });
      expect(refused).toMatchObject({ code: '23503', constraint: 'node_filter_rows_node_fkey' });
    });

    it('a node refuses a family its type does not have', async () => {
      const refused = await as(A, (client) =>
        refusal(run(client, insertNode(A.org, A.project, { family: 'docs_page' }))),
      );
      expect(refused).toMatchObject({ code: '23503', constraint: 'nodes_type_fkey' });
    });
  });

  describe('history', () => {
    it.each([
      ['update', `update app.node_versions set ast_version = 2 where id = $1`],
      ['delete', `delete from app.node_versions where id = $1`],
    ])('%s of a stored version is refused for the app role', async (_name, statement) => {
      const refused = await as(A, (client) => refusal(client.query(statement, [A.version])));
      expect(refused.code).toBe('42501');
    });

    it('still takes a new version', async () => {
      const done = await as(A, (client) => run(client, insertVersion(A.org, A.project)));
      expect(done.rowCount).toBe(1);
    });

    it('holds only select and insert for the app role', async () => {
      const privileges = await superuser(
        `select string_agg(privilege_type, ',' order by privilege_type)
           from information_schema.role_table_grants
          where grantee = 'drefyn_app' and table_schema = 'app' and table_name = 'node_versions';`,
        db.name,
      );
      expect(privileges.trim()).toBe('INSERT,SELECT');
    });
  });

  describe('organization node counts', () => {
    const add = (client: pg.Client, org: string, family: string) =>
      client.query(
        `insert into app.organization_node_counts (organization_id, family, nodes)
         values ($1, $2, 1)`,
        [org, family],
      );

    it('is one row an organization reaches from each of its projects', async () => {
      const seen = await as(A, async (client) => {
        await add(client, A.org, 'docs_page');
        const read = await client.query<{ nodes: string }>(
          `select nodes from app.organization_node_counts`,
        );
        return read.rows;
      });
      expect(seen).toEqual([{ nodes: '1' }]);
    });

    it('is out of reach for another organization', async () => {
      const refused = await as(B, (client) => refusal(add(client, A.org, 'docs_page')));
      expect(refused.code).toBe('42501');
    });

    it('reads as empty for another organization', async () => {
      const rows = await within(B.org, B.project, (client) =>
        client.query(`select 1 from app.organization_node_counts where organization_id = $1`, [
          A.org,
        ]),
      );
      expect(rows.rowCount).toBe(0);
    });

    it('refuses a family outside the set and a count below zero', async () => {
      const family = await as(A, (client) => refusal(add(client, A.org, 'blog_post')));
      expect(family.code).toBe('23514');
      const negative = await as(A, (client) =>
        refusal(
          client.query(
            `insert into app.organization_node_counts (organization_id, family, nodes)
             values ($1, 'docs_page', -1)`,
            [A.org],
          ),
        ),
      );
      expect(negative.code).toBe('23514');
    });
  });

  describe('closed sets and unique keys', () => {
    it.each([
      ['nodes_family_check', () => insertNode(A.org, A.project, { family: 'blog_post' })],
      ['nodes_lifecycle_check', () => insertNode(A.org, A.project, { lifecycle: 'deleted' })],
      ['node_versions_origin_check', () => insertVersion(A.org, A.project, { origin: 'webhook' })],
      [
        'node_versions_content_sha256_check',
        () => insertVersion(A.org, A.project, { sha: Buffer.alloc(31) }),
      ],
      [
        'chunk_embeddings_body_sha256_check',
        () => insertEmbedding(A.org, A.project, { sha: Buffer.alloc(31) }),
      ],
    ])('%s refuses a value outside the set', async (constraint, write) => {
      const refused = await as(A, (client) => refusal(run(client, write())));
      expect(refused).toMatchObject({ code: '23514', constraint });
    });

    it('content_types refuses a family outside the set', async () => {
      const refused = await as(A, (client) =>
        refusal(
          client.query(
            `insert into app.content_types (organization_id, project_id, family, key)
             values ($1, $2, 'blog_post', 'x')`,
            [A.org, A.project],
          ),
        ),
      );
      expect(refused).toMatchObject({ code: '23514', constraint: 'content_types_family_check' });
    });

    it.each([
      'docs_page',
      'studio_item',
      'status_component',
      'status_incident',
      'status_incident_update',
      'status_maintenance',
      'status_postmortem',
    ])('nodes take the family %s', async (family) => {
      const done = await as(A, async (client) => {
        const type = await client.query<{ id: string }>(
          `insert into app.content_types (organization_id, project_id, family, key)
           values ($1, $2, $3, 'of-family') returning id`,
          [A.org, A.project, family],
        );
        return run(client, insertNode(A.org, A.project, { family, type: firstId(type) }));
      });
      expect(done.rowCount).toBe(1);
    });

    it.each(['draft', 'published', 'archived'])(
      'nodes take the lifecycle %s',
      async (lifecycle) => {
        const done = await as(A, (client) =>
          run(client, insertNode(A.org, A.project, { lifecycle })),
        );
        expect(done.rowCount).toBe(1);
      },
    );

    it.each(['human', 'ai', 'git', 'import'])('versions take the origin %s', async (origin) => {
      const done = await as(A, (client) =>
        run(client, insertVersion(A.org, A.project, { origin })),
      );
      expect(done.rowCount).toBe(1);
    });

    it('refuses a version sequence used twice on one node', async () => {
      const refused = await as(A, (client) =>
        refusal(run(client, insertVersion(A.org, A.project, { seq: 1 }))),
      );
      expect(refused).toMatchObject({ code: '23505', constraint: 'node_versions_node_seq_key' });
    });

    it('refuses an idempotency key used twice in a project', async () => {
      const refused = await as(A, (client) =>
        refusal(run(client, insertVersion(A.org, A.project, { key: 'first-save' }))),
      );
      expect(refused).toMatchObject({
        code: '23505',
        constraint: 'node_versions_idempotency_key',
      });
    });

    it('takes any number of versions with no idempotency key', async () => {
      await as(A, async (client) => {
        await run(client, insertVersion(A.org, A.project, { seq: 2 }));
        await run(client, insertVersion(A.org, A.project, { seq: 3 }));
      });
    });

    it('refuses a body hash and model pair stored twice in a project', async () => {
      const refused = await as(A, (client) =>
        refusal(
          run(client, insertEmbedding(A.org, A.project, { sha: hash('bb'), model: 'model-1' })),
        ),
      );
      expect(refused).toMatchObject({
        code: '23505',
        constraint: 'chunk_embeddings_body_model_key',
      });
    });

    it('refuses a content type key used twice in a project', async () => {
      const refused = await as(A, (client) =>
        refusal(
          client.query(
            `insert into app.content_types (organization_id, project_id, family, key)
             values ($1, $2, 'studio_item', 'article')`,
            [A.org, A.project],
          ),
        ),
      );
      expect(refused).toMatchObject({ code: '23505', constraint: 'content_types_key_key' });
    });

    it('refuses a second filter row for a node', async () => {
      const refused = await as(A, (client) =>
        refusal(run(client, insertFilterRow(A.org, A.project, { node: A.node }))),
      );
      expect(refused).toMatchObject({ code: '23505', constraint: 'node_filter_rows_pkey' });
    });

    // The seed gave every tenant the same version key, type key and hash and model pair. A
    // global key would have refused the seed, and would tell one tenant what another stored.
    it('scopes each unique key to the project', async () => {
      const counted = await superuser(
        `select (select count(*) from app.node_versions where idempotency_key = 'first-save')
             || '|' || (select count(*) from app.content_types where key = 'article')
             || '|' || (select count(*) from app.chunk_embeddings where model_id = 'model-1');`,
        db.name,
      );
      expect(counted.trim()).toBe('3|3|3');
    });
  });

  describe('roles', () => {
    it.each(TABLE_NAMES)('the public reader cannot read or write %s', async (table) => {
      const read = await within(
        A.org,
        A.project,
        (client) => refusal(client.query(`select 1 from app.${table}`)),
        'reader',
      );
      const write = await within(
        A.org,
        A.project,
        (client) => refusal(client.query(`delete from app.${table}`)),
        'reader',
      );
      expect([read.code, write.code]).toEqual(['42501', '42501']);
    });

    it.each(TABLE_NAMES)('the sign in role cannot read or write %s', async (table) => {
      const read = await within(
        '',
        '',
        (client) => refusal(client.query(`select 1 from app.${table}`)),
        'auth',
      );
      const write = await within(
        '',
        '',
        (client) => refusal(client.query(`delete from app.${table}`)),
        'auth',
      );
      expect([read.code, write.code]).toEqual(['42501', '42501']);
    });

    it.each(TABLE_NAMES)('the owner reads none of %s', async (table) => {
      const owner = await within(A.org, A.project, (client) => count(client, table), 'owner');
      expect(owner).toBe(0);
    });
  });

  describe('the catalog', () => {
    it('passes the check with the shipped lists', async () => {
      expect(await catalogProblems(db.owner, ALLOW_LISTS)).toEqual([]);
    });

    it('forces row level security on all seven tables', async () => {
      const forced = await superuser(
        `select count(*) from pg_class
          where oid in (${NAMES_LIST}) and relrowsecurity and relforcerowsecurity;`,
        db.name,
      );
      expect(forced.trim()).toBe('7');
    });

    it('has only the narrow project policy, with no null arm', async () => {
      const policies = await superuser(
        `set search_path = pg_catalog;
         select distinct polname || '|' || pg_get_expr(polqual, polrelid) || '|' ||
                pg_get_expr(polwithcheck, polrelid)
           from pg_policy where polrelid in (${NAMES_LIST});`,
        db.name,
      );
      const narrow =
        '((organization_id = app.current_org()) AND (project_id = app.current_project()))';
      expect(policies.trim()).toBe(`tenant_isolation|${narrow}|${narrow}`);
    });

    it('gives every composite foreign key target tenant statistics', async () => {
      const found = await superuser(
        `select stxrelid::regclass::text || '|' || stxname || '|' || stxkind::text
           from pg_statistic_ext where stxnamespace = 'app'::regnamespace order by 1;`,
        db.name,
      );
      expect(found.trim().split('\n')).toEqual([
        'content_types|content_types_tenant_stats|{d,f}',
        'node_versions|node_versions_tenant_stats|{d,f}',
        'nodes|nodes_tenant_stats|{d,f}',
      ]);
    });

    it('fails the check when those statistics are dropped', async () => {
      const fresh = await dbs.fresh('migrated');
      await superuser('drop statistics app.nodes_tenant_stats;', fresh.name);
      expect(await catalogProblems(fresh.owner, ALLOW_LISTS)).toEqual([
        expect.objectContaining({ rule: 'tenant_statistics', object: 'app.nodes' }),
      ]);
    });

    it('holds no GIN index, since none can run under forced row level security', async () => {
      const gin = await superuser(
        `select count(*) from pg_index x
           join pg_class i on i.oid = x.indexrelid join pg_am a on a.oid = i.relam
          where x.indrelid in (${NAMES_LIST}) and a.amname <> 'btree';`,
        db.name,
      );
      expect(gin.trim()).toBe('0');
    });

    it('keeps the indexes lists depend on', async () => {
      const definition = async (name: string) =>
        (await superuser(`select pg_get_indexdef('app.${name}'::regclass);`, db.name)).trim();
      expect(await definition('nodes_type')).toContain(
        'btree (organization_id, project_id, type_id, id)',
      );
      expect(await definition('nodes_roots')).toMatch(
        /btree \(organization_id, project_id, order_key\) WHERE \(parent_id IS NULL\)/,
      );
      expect(await definition('nodes_children')).toContain(
        'btree (organization_id, project_id, parent_id, order_key)',
      );
      expect(await definition('node_filter_rows_pkey')).toContain(
        'btree (organization_id, project_id, type_id, node_id) ' +
          'INCLUDE (t1, t2, t3, t4, t5, l1, l2, l3, l4, l5, i1, i2, i3, i4, i5, d1, d2)',
      );
    });

    it('stores embeddings as the extension halfvec type', async () => {
      const type = await superuser(
        `set search_path = pg_catalog;
         select atttypid::regtype::text from pg_attribute
          where attrelid = 'app.chunk_embeddings'::regclass and attname = 'embedding';`,
        db.name,
      );
      expect(type.trim()).toBe('extensions.halfvec');
    });

    it('has one index on filter rows, so a save rewrites one key', async () => {
      const indexes = await superuser(
        `select count(*) from pg_index where indrelid = 'app.node_filter_rows'::regclass;`,
        db.name,
      );
      expect(indexes.trim()).toBe('1');
    });

    // A scale factor counts the whole shared table, so vacuum would slow as the platform grows.
    it('fixes the vacuum thresholds on filter rows', async () => {
      const options = await superuser(
        `select unnest(reloptions) from pg_class
          where oid = 'app.node_filter_rows'::regclass order by 1;`,
        db.name,
      );
      expect(options.trim().split('\n')).toEqual([
        'autovacuum_vacuum_cost_delay=0',
        'autovacuum_vacuum_insert_scale_factor=0',
        'autovacuum_vacuum_insert_threshold=2000',
        'autovacuum_vacuum_scale_factor=0',
        'autovacuum_vacuum_threshold=2000',
        'fillfactor=90',
      ]);
    });

    it('holds the slot map as an object on the content type', async () => {
      const refused = await as(A, (client) =>
        refusal(client.query(`update app.content_types set filter_slots = '[]'`)),
      );
      expect(refused).toMatchObject({
        code: '23514',
        constraint: 'content_types_filter_slots_check',
      });
    });
  });

  describe('the filter row plan', () => {
    // A dominant tenant correctly seq scans, so the plan is proved on a small one beside it.
    it('is an index only scan with the policy as index condition', async () => {
      const big = tenant(1, 11, 100);
      const small = tenant(2, 21, 300);
      const fresh = await dbs.fresh('migrated');
      await superuser(
        `${seedSql}
         insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle)
           select o, p, 'studio_item', t, 'k' || n, 'draft'
             from (values ('${big.org}'::uuid, '${big.project}'::uuid, '${big.type}'::uuid, 6000),
                          ('${small.org}', '${small.project}', '${small.type}', 200)) v(o, p, t, c),
                  generate_series(1, c) n;
         insert into app.node_filter_rows (organization_id, project_id, type_id, node_id, t1, i1)
           select organization_id, project_id, type_id, id, 'value', 7 from app.nodes
            where order_key like 'k%';`,
        fresh.name,
      );
      await superuser(
        'vacuum (analyze) app.node_filter_rows; vacuum (analyze) app.nodes;',
        fresh.name,
      );
      const client = await session('app', fresh.name);
      try {
        await client.query('begin');
        await client.query("select set_config('drefyn.organization_id', $1, true)", [small.org]);
        await client.query("select set_config('drefyn.project_id', $1, true)", [small.project]);
        const explained = await client.query<{ 'QUERY PLAN': readonly { Plan: PlanNode }[] }>(
          `explain (analyze, format json)
           select node_id, t1, i1 from app.node_filter_rows
            where type_id = '${small.type}' and i1 = 7 order by t1 limit 20`,
        );
        const root = explained.rows[0]?.['QUERY PLAN'][0]?.Plan;
        if (root === undefined) throw new Error('no plan');
        const scans = flatten(root).filter((node) => node['Node Type'].includes('Scan'));
        expect(scans).toHaveLength(1);
        const scan = scans[0];
        expect(scan?.['Node Type']).toBe('Index Only Scan');
        expect(scan?.['Index Name']).toBe('node_filter_rows_pkey');
        expect(scan?.['Heap Fetches']).toBe(0);
        expect(scan?.['Index Cond']).toMatch(/organization_id = .*current_(org\(\)|setting)/);
        expect(scan?.['Index Cond']).toMatch(/project_id = .*current_(project\(\)|setting)/);
        await client.query('rollback');
      } finally {
        await client.end();
      }
    });
  });

  describe('the migration', () => {
    const stepsBack = (name = '_engine_tables.sql') => {
      const shipped = shippedMigrations();
      const at = shipped.findIndex((file) => file.endsWith(name));
      expect(at).toBeGreaterThanOrEqual(0);
      return shipped.length - at;
    };

    const tablesPresent = async (database: string) =>
      (
        await superuser(
          `select count(*) from pg_class where relnamespace = 'app'::regnamespace
            and relkind = 'r' and relname in (${TABLE_NAMES.map((t) => `'${t}'`).join(', ')});`,
          database,
        )
      ).trim();

    it('goes down over stored rows, leaves nothing behind, and comes back up', async () => {
      const fresh = await dbs.fresh('migrated');
      await superuser(seedSql, fresh.name);
      expect(await tablesPresent(fresh.name)).toBe('7');

      const down = await migrate(['migrate', 'down', String(stepsBack())], { url: fresh.owner });
      expect(down.code, describeFailure(down)).toBe(0);
      expect(await tablesPresent(fresh.name)).toBe('0');
      const statistics = await superuser(
        `select count(*) from pg_statistic_ext where stxnamespace = 'app'::regnamespace;`,
        fresh.name,
      );
      expect(statistics.trim()).toBe('0');

      const up = await migrate(['migrate', 'up'], { url: fresh.owner });
      expect(up.code, describeFailure(up)).toBe(0);
      expect(await tablesPresent(fresh.name)).toBe('7');
      expect(await catalogProblems(fresh.owner, ALLOW_LISTS)).toEqual([]);
    });

    it('takes the write path rules off and puts them back over stored rows', async () => {
      const fresh = await dbs.fresh('migrated');
      await superuser(seedSql, fresh.name);
      const privileges = async () =>
        (
          await superuser(
            `select count(*) from information_schema.role_table_grants
              where grantee = 'drefyn_app' and table_schema = 'app'
                and table_name = 'node_versions'
                and privilege_type in ('UPDATE', 'DELETE');`,
            fresh.name,
          )
        ).trim();
      const keyColumns = async (name: string) =>
        (
          await superuser(
            `select array_length(conkey, 1) from pg_constraint where conname = '${name}';`,
            fresh.name,
          )
        ).trim();
      expect(await privileges()).toBe('0');
      expect(await keyColumns('nodes_head_version_fkey')).toBe('4');

      const down = await migrate(['migrate', 'down', String(stepsBack('_engine_write_path.sql'))], {
        url: fresh.owner,
      });
      expect(down.code, describeFailure(down)).toBe(0);
      expect(await privileges()).toBe('2');
      expect(await keyColumns('nodes_head_version_fkey')).toBe('3');
      expect(await keyColumns('chunks_node_fkey')).toBe('3');
      const counts = await superuser(
        `select to_regclass('app.organization_node_counts');`,
        fresh.name,
      );
      expect(counts.trim()).toBe('');
      const versions = await superuser(`select count(*) from app.node_versions;`, fresh.name);
      expect(versions.trim()).toBe('3');
      expect(await catalogProblems(fresh.owner, ALLOW_LISTS)).toEqual([]);

      const up = await migrate(['migrate', 'up'], { url: fresh.owner });
      expect(up.code, describeFailure(up)).toBe(0);
      expect(await privileges()).toBe('0');
      expect(await keyColumns('nodes_head_version_fkey')).toBe('4');
      expect(await catalogProblems(fresh.owner, ALLOW_LISTS)).toEqual([]);
    });
  });
});
