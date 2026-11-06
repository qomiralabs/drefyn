import { closeDatabase, type Database } from '@drefyn/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Engine, EngineResult, NodeId } from '../src/index.ts';
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
  type Built,
  type Seeded,
} from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';

let db: Database;
let built: Built;
let engine: Engine;

const FREE_DOCS_PAGES = 50;

const setCount = (seeded: Seeded, family: string, nodes: number) =>
  admin(`
insert into app.organization_node_counts (organization_id, family, nodes)
  values ('${seeded.organization}', '${family}', ${String(nodes)})
  on conflict (organization_id, family) do update set nodes = excluded.nodes;`);

const countOf = async (seeded: Seeded, family = 'docs_page') =>
  Number(
    await admin(`
select coalesce(sum(nodes), 0) from app.organization_node_counts
 where organization_id = '${seeded.organization}' and family = '${family}';`),
  );

const create = (seeded: Seeded) =>
  engine.createNode({ tenant: seeded.tenant, family: 'docs_page', typeId: seeded.typeId });

const codeOf = (result: EngineResult<unknown>) => (result.ok ? 'ok' : result.error.code);

const attempt = async (seeded: Seeded, node: NodeId, expected: string | null, text: string) =>
  engine.saveDraft({
    tenant: seeded.tenant,
    nodeId: node,
    expectedHeadVersionId: expected as never,
    content: await tree(built.parse, seeded, text),
    origin: 'human',
    actor: ACTOR,
    idempotencyKey: key(),
  });

describeWithStack('limits and read only state', () => {
  beforeAll(async () => {
    db = await openDatabase();
    built = buildEngine(db);
    ({ engine } = built);
  });
  afterAll(async () => {
    await closeDatabase(db);
  });

  it('counts each node it creates', async () => {
    const seeded = await seed({ tier: 'free' });
    await create(seeded);
    await create(seeded);
    expect(await countOf(seeded)).toBe(2);
  });

  it('allows the last node under the limit and refuses the next', async () => {
    const seeded = await seed({ tier: 'free' });
    await setCount(seeded, 'docs_page', FREE_DOCS_PAGES - 1);
    expect(codeOf(await create(seeded))).toBe('ok');
    expect(codeOf(await create(seeded))).toBe('engine.limit_reached');
    expect(await countOf(seeded)).toBe(FREE_DOCS_PAGES);
    expect(
      await admin(`select count(*) from app.nodes where project_id = '${seeded.project}'`),
    ).toBe('1');
  });

  it('counts across the projects of an organization', async () => {
    const first = await seed({ tier: 'free' });
    const second = await seed({ organization: first.organization });
    await setCount(first, 'docs_page', FREE_DOCS_PAGES - 1);
    expect(codeOf(await create(first))).toBe('ok');
    expect(codeOf(await create(second))).toBe('engine.limit_reached');
  });

  it('never lets racing creates pass the limit', async () => {
    const seeded = await seed({ tier: 'free' });
    await setCount(seeded, 'docs_page', FREE_DOCS_PAGES - 2);
    const results = await Promise.all(Array.from({ length: 8 }, () => create(seeded)));
    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(await countOf(seeded)).toBe(FREE_DOCS_PAGES);
  });

  it('has no limit on a self hosted install', async () => {
    const seeded = await seed({ tier: 'self_hosted' });
    await setCount(seeded, 'docs_page', 1_000_000);
    expect(codeOf(await create(seeded))).toBe('ok');
  });

  it('counts a family through its own limit', async () => {
    const seeded = await seed({
      tier: 'free',
      product: 'status',
      family: 'status_component',
    });
    await setCount(seeded, 'status_component', 25);
    const done = await engine.createNode({
      tenant: seeded.tenant,
      family: 'status_component',
      typeId: seeded.typeId,
    });
    expect(codeOf(done)).toBe('engine.limit_reached');
  });

  it('leaves a family with no limit alone', async () => {
    const seeded = await seed({ tier: 'free', product: 'status', family: 'status_incident' });
    const done = await engine.createNode({
      tenant: seeded.tenant,
      family: 'status_incident',
      typeId: seeded.typeId,
    });
    expect(codeOf(done)).toBe('ok');
  });

  it.each([
    [
      'organization',
      (seeded: Seeded) => `update app.organizations set read_only_since = now()
       where organization_id = '${seeded.organization}';`,
    ],
    [
      'project',
      (seeded: Seeded) => `update app.projects set read_only_since = now()
       where id = '${seeded.project}';`,
    ],
  ])('a read only %s writes nothing and keeps everything readable', async (_scope, mark) => {
    const seeded = await seed({ tier: 'free' });
    const node = await newNode(engine, seeded);
    const one = await save(built, seeded, node, null, 'one\n');
    const two = await save(built, seeded, node, one.versionId, 'two\n');
    await admin(mark(seeded));

    expect(codeOf(await attempt(seeded, node, two.versionId, 'three\n'))).toBe('engine.read_only');
    expect(codeOf(await create(seeded))).toBe('engine.read_only');
    expect(
      codeOf(
        await engine.rollback({
          tenant: seeded.tenant,
          nodeId: node,
          toVersionId: one.versionId,
          expectedHeadVersionId: two.versionId,
          actor: ACTOR,
          idempotencyKey: key(),
        }),
      ),
    ).toBe('engine.read_only');

    const head = await engine.getHead(seeded.tenant, node);
    expect(head.ok && head.value.seq).toBe(2);
    const listed = await engine.listVersions(seeded.tenant, node, {});
    expect(listed.ok && listed.value.items).toHaveLength(2);
  });

  it('treats an organization over its limit as read only, before billing marks it', async () => {
    const seeded = await seed({ tier: 'free' });
    const node = await newNode(engine, seeded);
    const one = await save(built, seeded, node, null, 'one\n');
    await setCount(seeded, 'docs_page', FREE_DOCS_PAGES + 1);

    expect(codeOf(await attempt(seeded, node, one.versionId, 'two\n'))).toBe('engine.read_only');
    expect(codeOf(await create(seeded))).toBe('engine.read_only');
    const head = await engine.getHead(seeded.tenant, node);
    expect(head.ok && head.value.seq).toBe(1);
  });

  it('still saves at exactly the limit', async () => {
    const seeded = await seed({ tier: 'free' });
    const node = await newNode(engine, seeded);
    await setCount(seeded, 'docs_page', FREE_DOCS_PAGES);
    expect(codeOf(await attempt(seeded, node, null, 'one\n'))).toBe('ok');
  });

  it('still replays a finished save once read only', async () => {
    const seeded = await seed({ tier: 'free' });
    const node = await newNode(engine, seeded);
    const ask = {
      tenant: seeded.tenant,
      nodeId: node,
      expectedHeadVersionId: null,
      content: await tree(built.parse, seeded, 'one\n'),
      origin: 'human' as const,
      actor: ACTOR,
      idempotencyKey: key(),
    };
    const first = await engine.saveDraft(ask);
    await admin(
      `update app.organizations set read_only_since = now()
        where organization_id = '${seeded.organization}';`,
    );
    expect(await engine.saveDraft(ask)).toEqual(first);
  });
});
