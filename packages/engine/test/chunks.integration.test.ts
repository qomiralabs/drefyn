import { randomUUID } from 'node:crypto';
import { closeDatabase, withTenant, type Database } from '@drefyn/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  chunkNode,
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  type EngineFlags,
  type EngineStore,
  type NodeId,
  type VersionId,
} from '../src/index.ts';
import {
  ACTOR,
  admin,
  buildEngine,
  key,
  newNode,
  openDatabase,
  save,
  seed,
  tree,
  versionCount,
  type Built,
  type Seeded,
} from './support/fixture.ts';
import { chunkForeignKeyCost } from './support/foreign-keys.ts';
import { describeWithStack } from './support/presence.ts';
import { sourceOf } from './support/tree.ts';

const chunkOptions = {
  targetChars: DEFAULT_ENGINE_CONFIG.chunkTargetChars,
  maxChars: DEFAULT_ENGINE_CONFIG.chunkMaxChars,
};

const PAGE = `# Guide

Words about the guide.

## Install

Run the installer.

\`\`\`sh
pnpm install
\`\`\`

## Use

${'A line of real prose that runs on for a while. '.repeat(40)}
`;

let db: Database;
let built: Built;
let home: Seeded;
let other: Seeded;

const count = async (table: string, version: string): Promise<number> =>
  Number(await admin(`select count(*) from app.${table} where version_id = '${version}';`));

const countByNode = async (table: string, node: string): Promise<number> =>
  Number(await admin(`select count(*) from app.${table} where node_id = '${node}';`));

const flagged = (chunkAtWrite: boolean): EngineFlags => ({
  isOn: (name) => Promise.resolve(name === 'engine.writes' || chunkAtWrite),
});

const saveInput = async (seeded: Seeded, nodeId: NodeId, head: VersionId | null, text: string) => ({
  tenant: seeded.tenant,
  nodeId,
  expectedHeadVersionId: head,
  content: await tree(built.parse, seeded, text),
  origin: 'human' as const,
  actor: ACTOR,
  idempotencyKey: key(),
});

beforeAll(async () => {
  db = await openDatabase();
  built = buildEngine(db);
  home = await seed();
  other = await seed();
});

afterAll(async () => {
  await closeDatabase(db);
});

describeWithStack('chunks in the save transaction', () => {
  it('stores the chunks of the saved tree, in order, with the outbox row', async () => {
    const node = await newNode(built.engine, home);
    const input = await saveInput(home, node, null, PAGE);
    const saved = await built.engine.saveDraft(input);
    if (!saved.ok) throw new Error(saved.error.code);
    const version = saved.value.versionId;

    const expected = chunkNode(input.content, chunkOptions);
    const rows = JSON.parse(
      await admin(`
select coalesce(json_agg(json_build_object(
         'ord', ord, 'blockPath', block_path, 'headingPath', heading_path, 'body', body,
         'hashed', body_sha256 = sha256(convert_to(body, 'UTF8')),
         'organization', organization_id, 'project', project_id, 'node', node_id)
       order by ord), '[]')
  from app.chunks where version_id = '${version}';`),
    ) as readonly Record<string, unknown>[];

    expect(rows.length).toBe(expected.length);
    expect(rows.map(({ body }) => body).join('')).toBe(sourceOf(input.content));
    for (const [at, row] of rows.entries()) {
      expect(row).toMatchObject({
        ...expected[at],
        hashed: true,
        organization: home.organization,
        project: home.project,
        node,
      });
    }

    const outbox = await admin(`
select organization_id || ' ' || project_id || ' ' || node_id || ' ' || kind || ' ' ||
       (done_at is null)::text
  from app.engine_outbox where version_id = '${version}';`);
    expect(outbox).toBe(`${home.organization} ${home.project} ${node} embed_chunks true`);
  });

  it('gives every version its own chunks', async () => {
    const node = await newNode(built.engine, home);
    const first = await save(built, home, node, null, 'First body.');
    const second = await save(built, home, node, first.versionId, 'Second body.');
    expect(await count('chunks', first.versionId)).toBe(1);
    expect(await count('chunks', second.versionId)).toBe(1);
    expect(await count('engine_outbox', second.versionId)).toBe(1);
  });

  it('chunks a rollback, the same way the content first chunked', async () => {
    const node = await newNode(built.engine, home);
    const first = await save(built, home, node, null, PAGE);
    const second = await save(built, home, node, first.versionId, 'Replaced.');
    const back = await built.engine.rollback({
      tenant: home.tenant,
      nodeId: node,
      toVersionId: first.versionId,
      expectedHeadVersionId: second.versionId,
      actor: ACTOR,
      idempotencyKey: key(),
    });
    if (!back.ok) throw new Error(back.error.code);
    const bodies = (version: string) =>
      admin(`select md5(string_agg(body, '' order by ord)) from app.chunks
             where version_id = '${version}';`);
    expect(await bodies(back.value.versionId)).toBe(await bodies(first.versionId));
    expect(await count('engine_outbox', back.value.versionId)).toBe(1);
  });

  it('writes once when a save is replayed', async () => {
    const node = await newNode(built.engine, home);
    const input = await saveInput(home, node, null, PAGE);
    const first = await built.engine.saveDraft(input);
    const again = await built.engine.saveDraft(input);
    if (!first.ok || !again.ok) throw new Error('refused');
    expect(again.value.versionId).toBe(first.value.versionId);
    expect(await count('engine_outbox', first.value.versionId)).toBe(1);
  });

  // 65,535 is the wire limit on bind parameters, and a page of headings makes a row per heading.
  it('stores a page with more chunks than one statement can bind', async () => {
    const node = await newNode(built.engine, home);
    const headings = Array.from({ length: 14_000 }, (_, at) => `# ${String(at)}\n`).join('\n');
    const saved = await save(built, home, node, null, headings);
    expect(await count('chunks', saved.versionId)).toBe(14_000);
    expect(await count('engine_outbox', saved.versionId)).toBe(1);
  });

  it('leaves no outbox row for a page with nothing to embed', async () => {
    const node = await newNode(built.engine, home);
    const saved = await save(built, home, node, null, '');
    expect(await countByNode('chunks', node)).toBe(0);
    expect(await count('engine_outbox', saved.versionId)).toBe(0);
  });

  it('writes neither with the flag off, and both with it on', async () => {
    const off = buildEngine(db, { flags: flagged(false) });
    const on = buildEngine(db, { flags: flagged(true) });
    const node = await newNode(off.engine, home);
    const quiet = await save(off, home, node, null, PAGE);
    expect(await countByNode('chunks', node)).toBe(0);
    expect(await countByNode('engine_outbox', node)).toBe(0);
    const loud = await save(on, home, node, quiet.versionId, `${PAGE}\nMore.\n`);
    expect(await count('chunks', loud.versionId)).toBeGreaterThan(0);
    expect(await count('engine_outbox', loud.versionId)).toBe(1);
  });
});

describeWithStack('a crash mid save', () => {
  const nothingStored = async (node: string) => {
    expect(await versionCount(node)).toBe(0);
    expect(await countByNode('chunks', node)).toBe(0);
    expect(await countByNode('engine_outbox', node)).toBe(0);
    expect(await admin(`select head_version_id is null from app.nodes where id = '${node}';`)).toBe(
      't',
    );
  };

  it('keeps nothing when the connection dies after every write, before commit', async () => {
    const real = databaseStore(db);
    let arm = false;
    const dying: EngineStore = {
      tenant: (tenant, work) =>
        real.tenant(tenant, async (tx) => {
          const answer = await work(tx);
          if (arm) {
            const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
            await admin(`select pg_terminate_backend(${String(rows[0]?.pid)});`);
          }
          return answer;
        }),
    };
    const crashing = buildEngine(db, { store: dying });
    const node = await newNode(crashing.engine, home);
    const input = await saveInput(home, node, null, PAGE);
    arm = true;
    await crashing.engine.saveDraft(input).then(
      (done) => {
        expect(done.ok).toBe(false);
      },
      () => undefined,
    );
    arm = false;
    await nothingStored(node);
  });

  it('keeps nothing when the server stops it part way through the chunks', async () => {
    const node = await newNode(built.engine, home);
    const trigger = `crash_${randomUUID().replaceAll('-', '')}`;
    await admin(`
create function app.${trigger}() returns trigger language plpgsql as $$
begin
  if new.node_id = '${node}' and new.ord = 1 then raise exception 'injected'; end if;
  return new;
end $$;
create trigger ${trigger} before insert on app.chunks
  for each row execute function app.${trigger}();`);
    try {
      await built.engine.saveDraft(await saveInput(home, node, null, PAGE)).then(
        (done) => {
          expect(done.ok).toBe(false);
        },
        () => undefined,
      );
    } finally {
      await admin(`drop trigger ${trigger} on app.chunks; drop function app.${trigger}();`);
    }
    await nothingStored(node);
  });
});

describeWithStack('chunks across tenants', () => {
  const chunksSeenBy = (seeded: Seeded, node: string) =>
    withTenant(db, seeded.tenant, (tx) =>
      tx
        .selectFrom('chunks')
        .select('body')
        .where('organization_id', '=', seeded.tenant.organizationId)
        .where('project_id', '=', seeded.tenant.projectId)
        .where('node_id', '=', node)
        .execute(),
    );

  it('hides chunks and outbox rows from a second tenant, even by raw count', async () => {
    const node = await newNode(built.engine, home);
    await save(built, home, node, null, PAGE);
    expect((await chunksSeenBy(home, node)).length).toBeGreaterThan(0);
    expect(await chunksSeenBy(other, node)).toEqual([]);
    const seen = await withTenant(db, other.tenant, async (tx) => {
      const chunks = await sql<{ total: string }>`
        select count(*) as total from app.chunks where node_id = ${node}`.execute(tx);
      const outbox = await sql<{ total: string }>`
        select count(*) as total from app.engine_outbox where node_id = ${node}`.execute(tx);
      return [chunks.rows[0]?.total, outbox.rows[0]?.total];
    });
    expect(seen.map(Number)).toEqual([0, 0]);
  });

  it('keeps a project of the same organization out too', async () => {
    const sibling = await seed({ organization: home.organization });
    const node = await newNode(built.engine, home);
    await save(built, home, node, null, PAGE);
    expect(await chunksSeenBy(sibling, node)).toEqual([]);
  });

  it('answers not found to a save on another tenant, and writes no chunk', async () => {
    const node = await newNode(built.engine, home);
    const done = await built.engine.saveDraft({
      ...(await saveInput(other, node, null, PAGE)),
      tenant: other.tenant,
    });
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.not_found' } });
    expect(await countByNode('chunks', node)).toBe(0);
    expect(await countByNode('engine_outbox', node)).toBe(0);
  });

  it('gives each tenant its own rows for the same text', async () => {
    const mine = await newNode(built.engine, home);
    const theirs = await newNode(built.engine, other);
    const a = await save(built, home, mine, null, PAGE);
    const b = await save(built, other, theirs, null, PAGE);
    const owners = await admin(`
select count(distinct organization_id) from app.chunks
  where version_id in ('${a.versionId}', '${b.versionId}');`);
    expect(owners).toBe('2');
    expect((await chunksSeenBy(other, mine)).length).toBe(0);
    expect((await chunksSeenBy(home, theirs)).length).toBe(0);
  });

  it('refuses a chunk written under one tenant for another tenant', async () => {
    const node = await newNode(built.engine, other);
    const saved = await save(built, other, node, null, PAGE);
    const row = {
      node_id: node,
      version_id: saved.versionId,
      ord: 900,
      block_path: '0',
      heading_path: [],
      body: 'x',
      body_sha256: Buffer.alloc(32, 1),
    };
    await expect(
      withTenant(db, home.tenant, (tx) =>
        tx
          .insertInto('chunks')
          .values({
            ...row,
            organization_id: other.tenant.organizationId,
            project_id: other.tenant.projectId,
          })
          .execute(),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(db, home.tenant, (tx) =>
        tx
          .insertInto('chunks')
          .values({
            ...row,
            organization_id: home.tenant.organizationId,
            project_id: home.tenant.projectId,
          })
          .execute(),
      ),
    ).rejects.toThrow();
  });
});

describeWithStack('foreign key checks on a chunk insert', () => {
  const NODES = 20_000;
  const TAIL_TENANTS = 2000;
  const CHUNKS = 233;
  const BUDGET_MS = 50;

  const fill = async (seeded: Seeded, rows: number): Promise<void> => {
    await admin(`
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle)
  select '${seeded.organization}', '${seeded.project}', 'docs_page', '${seeded.typeId}', 'a',
         'draft'
  from generate_series(1, ${String(rows)});
insert into app.node_versions (organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256)
  select organization_id, project_id, id, 1, 1, 1, 'import', '{"kind":"system","job":"seed"}',
         '{}', sha256(id::text::bytea)
  from app.nodes where project_id = '${seeded.project}';`);
  };

  const ends = async (seeded: Seeded) =>
    (
      await admin(`
select node_id || ' ' || id from (
  (select node_id, id from app.node_versions where project_id = '${seeded.project}'
    order by id limit 1)
  union all
  (select node_id, id from app.node_versions where project_id = '${seeded.project}'
    order by id desc limit 1)) ends;`)
    )
      .split('\n')
      .map((line) => line.split(' ') as [string, string]);

  // The trap needs many tenants: with few, the two column estimate is close enough to be safe.
  const fillTail = () =>
    admin(`
create temp table tail as
  select gen_random_uuid() organization, gen_random_uuid() project, gen_random_uuid() type
  from generate_series(1, ${String(TAIL_TENANTS)});
insert into app.organizations (organization_id, name, plan_tier)
  select organization, 'Tail', 'self_hosted' from tail;
insert into app.projects (id, organization_id, product, slug, name)
  select project, organization, 'docs', 'tail', 'Tail' from tail;
insert into app.content_types (id, organization_id, project_id, family, key)
  select type, organization, project, 'docs_page', 'page' from tail;
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle)
  select organization, project, 'docs_page', type, 'a', 'draft'
  from tail, generate_series(1, 2);
insert into app.node_versions (organization_id, project_id, node_id, seq, schema_version,
    ast_version, origin, actor, content, content_sha256)
  select n.organization_id, n.project_id, n.id, 1, 1, 1, 'import',
         '{"kind":"system","job":"seed"}', '{}', sha256(n.id::text::bytea)
  from app.nodes n join tail on tail.project = n.project_id;`);

  let largest: Seeded;
  let second: Seeded;

  beforeAll(async () => {
    largest = await seed();
    second = await seed();
    await fill(largest, NODES);
    await fill(second, Math.floor(NODES / 4));
    await fillTail();
    await admin('vacuum analyze app.nodes; vacuum analyze app.node_versions;');
  }, 120_000);

  it.each([
    ['the largest tenant', () => largest],
    ['the next tenant', () => second],
  ])('stays under budget at both ends of %s', async (_name, tenantOf) => {
    const seeded = tenantOf();
    for (const [node, version] of await ends(seeded)) {
      const { organization, project } = seeded;
      const cost = await chunkForeignKeyCost(
        admin,
        { organization, project, node, version },
        CHUNKS,
      );
      expect(cost.checks).toBe(2);
      expect(cost.ms).toBeLessThan(BUDGET_MS);
    }
  });
});
