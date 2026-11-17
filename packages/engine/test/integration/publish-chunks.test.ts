import { closeDatabase, type Database } from '@drefyn/db';
import { idOf } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  type EngineStore,
  type NodeId,
  type VersionId,
} from '../../src/index.ts';
import {
  ACTOR,
  admin,
  buildEngine,
  key,
  newNode,
  save,
  seed,
  type Built,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import { openApp } from '../support/published.ts';
import {
  chunkRows,
  nodeWithVersions,
  publishChunks,
  recomputedTerms,
  storedTerms,
} from '../support/terms.ts';

let app: Database;
let built: Built;

const PAGE = `# Install

Add the package with pnpm.

## Configure

Set the token in your environment.

## Verify

Run the check command.
`;

const counts = async (seeded: Seeded) => {
  const scope = `organization_id = '${seeded.organization}' and project_id = '${seeded.project}'`;
  const out = await admin(`
select (select count(*) from app.published_versions where ${scope}) || ' ' ||
       (select count(*) from app.published_chunks where ${scope}) || ' ' ||
       (select count(*) from app.published_chunk_terms where ${scope}) || ' ' ||
       (select count(*) from app.published_term_stats where ${scope}) || ' ' ||
       (select count(*) from app.published_project_term_totals where ${scope});`);
  return out.trim();
};

class Injected extends Error {}

const publishInput = (seeded: Seeded, nodeId: NodeId, versionId: VersionId) => ({
  tenant: seeded.tenant,
  nodeId,
  versionId,
  expectedHeadVersionId: versionId,
  actor: ACTOR,
  idempotencyKey: key(),
});

describeWithStack('publish copies chunks', () => {
  beforeAll(async () => {
    app = await openApp();
    built = buildEngine(app);
  });

  afterAll(async () => {
    await closeDatabase(app);
  });

  it('writes exactly the version chunks, in order, with path, title and visibility resolved', async () => {
    const seeded = await seed();
    const parent = await nodeWithVersions(seeded, [], { slug: 'guides' });
    const made = await built.engine.createNode({
      tenant: seeded.tenant,
      family: 'docs_page',
      typeId: seeded.typeId,
      parentId: idOf('nod', parent.nodeId),
      slug: 'install',
    });
    if (!made.ok) throw new Error(made.error.code);
    const nodeId = made.value.nodeId;
    const saved = await save(built, seeded, nodeId, null, PAGE);
    const done = await built.engine.publish(publishInput(seeded, nodeId, saved.versionId));
    expect(done.ok).toBe(true);
    const drafts = await admin(`
select ord || '|' || array_to_string(heading_path, '>') || '|' || encode(body_sha256, 'hex')
  from app.chunks where version_id = '${saved.versionId}' order by ord;`);
    const copies = await admin(`
select ord || '|' || array_to_string(heading_path, '>') || '|' || encode(body_sha256, 'hex')
  from app.published_chunks where version_id = '${saved.versionId}' order by ord;`);
    const rows = drafts.trim().split('\n');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(copies).toBe(drafts);
    const resolved = await admin(`
select distinct page_path || '|' || title || '|' || visibility || '|' || is_current
  from app.published_chunks where version_id = '${saved.versionId}';`);
    expect(resolved.trim()).toBe('/guides/install|Install|public|true');
    const same = await admin(`
select count(*) from app.published_chunks p join app.chunks c
    on c.version_id = p.version_id and c.ord = p.ord and c.body = p.body
 where p.version_id = '${saved.versionId}';`);
    expect(same.trim()).toBe(String(rows.length));
    // The version row and the chunks came from one publish.
    const version = await admin(
      `select is_current from app.published_versions where version_id = '${saved.versionId}';`,
    );
    expect(version.trim()).toBe('t');
    expect(await storedTerms(app, seeded.tenant)).toEqual(
      await recomputedTerms(app, seeded.tenant),
    );
  });

  it('republishing through publish flips the old rows and keeps them', async () => {
    const seeded = await seed();
    const nodeId = await newNode(built.engine, seeded);
    const first = await save(built, seeded, nodeId, null, '# One\n\nFirst words.\n');
    expect((await built.engine.publish(publishInput(seeded, nodeId, first.versionId))).ok).toBe(
      true,
    );
    const second = await save(built, seeded, nodeId, first.versionId, '# Two\n\nSecond words.\n');
    expect((await built.engine.publish(publishInput(seeded, nodeId, second.versionId))).ok).toBe(
      true,
    );
    const rows = await chunkRows(seeded.tenant, nodeId);
    expect(
      rows.filter((r) => r.startsWith(first.versionId)).every((r) => r.includes(' false ')),
    ).toBe(true);
    expect(
      rows.filter((r) => r.startsWith(second.versionId)).every((r) => r.includes(' true ')),
    ).toBe(true);
    expect(rows.some((r) => r.startsWith(first.versionId))).toBe(true);
    expect(await storedTerms(app, seeded.tenant)).toEqual(
      await recomputedTerms(app, seeded.tenant),
    );
  });

  it('writes no chunk or term row with retrieval.v1 off, and publishes as before', async () => {
    const off = buildEngine(app, {
      flags: { evaluate: (name) => Promise.resolve({ value: name !== 'retrieval.v1' }) },
    });
    const seeded = await seed();
    const nodeId = await newNode(off.engine, seeded);
    const saved = await save(off, seeded, nodeId, null, PAGE);
    const done = await off.engine.publish(publishInput(seeded, nodeId, saved.versionId));
    expect(done.ok).toBe(true);
    expect(await counts(seeded)).toBe('1 0 0 0 0');
  });

  it('leaves no version, chunk or term row when the publish transaction fails at the end', async () => {
    const real = databaseStore(app, DEFAULT_ENGINE_CONFIG);
    const failing: EngineStore = {
      gate: real.gate,
      tenant: (tenant, work, options) =>
        real.tenant(
          tenant,
          async (tx) => {
            const value = await work(tx);
            // Only a publish wrote these; fail it after its last write.
            const { rows } = await sql<{ n: string }>`
              select count(*)::text as n from app.published_chunk_terms`.execute(tx);
            if (Number(rows[0]?.n ?? 0) > 0) throw new Injected('after the publish');
            return value;
          },
          options,
        ),
    };
    const failingEngine = buildEngine(app, { store: failing });
    const seeded = await seed();
    const nodeId = await newNode(failingEngine.engine, seeded);
    const saved = await save(failingEngine, seeded, nodeId, null, PAGE);
    await expect(
      failingEngine.engine.publish(publishInput(seeded, nodeId, saved.versionId)),
    ).rejects.toBeInstanceOf(Injected);
    expect(await counts(seeded)).toBe('0 0 0 0 0');
  });

  it('prefers the title field and falls back to the slug, and stands a node id in for a missing slug', async () => {
    const seeded = await seed();
    const titled = await nodeWithVersions(seeded, [[{ headingPath: ['Heading'], body: 'x' }]], {
      slug: 'titled',
      title: 'From the field',
    });
    const bare = await nodeWithVersions(seeded, [[{ headingPath: [], body: 'y' }]], {
      slug: 'bare',
    });
    const orphan = await nodeWithVersions(seeded, [[{ headingPath: [], body: 'z' }]]);
    for (const node of [titled, bare, orphan]) {
      await publishChunks(app, seeded, node.nodeId, {
        versionId: node.versionIds[0] ?? '',
        visibility: 'public',
      });
    }
    const read = async (nodeId: string) =>
      (
        await admin(
          `select page_path || '|' || title from app.published_chunks where node_id = '${nodeId}';`,
        )
      ).trim();
    expect(await read(titled.nodeId)).toBe('/titled|From the field');
    expect(await read(bare.nodeId)).toBe('/bare|bare');
    expect(await read(orphan.nodeId)).toBe(`/${orphan.nodeId}|`);
  });

  it('flips is_current on the old rows when a page is republished and keeps them', async () => {
    const seeded = await seed();
    const node = await nodeWithVersions(seeded, [
      [
        { headingPath: ['One'], body: 'first version' },
        { headingPath: ['One'], body: 'more' },
      ],
      [{ headingPath: ['Two'], body: 'second version' }],
    ]);
    const [v1, v2] = node.versionIds;
    if (v1 === undefined || v2 === undefined) throw new Error('no versions');
    await publishChunks(app, seeded, node.nodeId, { versionId: v1, visibility: 'public' });
    await publishChunks(app, seeded, node.nodeId, { versionId: v2, visibility: 'public' });
    expect(await chunkRows(seeded.tenant, node.nodeId)).toEqual(
      [`${v1} 0 false public`, `${v1} 1 false public`, `${v2} 0 true public`].sort(),
    );
    // Back to the first: its rows come back as current under the same ids.
    const ids = await admin(
      `select id from app.published_chunks where version_id = '${v1}' order by ord;`,
    );
    await publishChunks(app, seeded, node.nodeId, { versionId: v1, visibility: 'public' });
    expect(await chunkRows(seeded.tenant, node.nodeId)).toEqual(
      [`${v1} 0 true public`, `${v1} 1 true public`, `${v2} 0 false public`].sort(),
    );
    expect(
      await admin(`select id from app.published_chunks where version_id = '${v1}' order by ord;`),
    ).toBe(ids);
    expect(await storedTerms(app, seeded.tenant)).toEqual(
      await recomputedTerms(app, seeded.tenant),
    );
  });

  it('removes a page from the term tables on unpublish and keeps its chunk rows as history', async () => {
    const seeded = await seed();
    const node = await nodeWithVersions(seeded, [[{ headingPath: [], body: 'gone soon' }]]);
    await publishChunks(app, seeded, node.nodeId, {
      versionId: node.versionIds[0] ?? '',
      visibility: 'public',
    });
    await publishChunks(app, seeded, node.nodeId, null);
    expect(await chunkRows(seeded.tenant, node.nodeId)).toEqual([
      `${node.versionIds[0] ?? ''} 0 false public`,
    ]);
    expect(await storedTerms(app, seeded.tenant)).toEqual({ totals: [], stats: [], postings: [] });
  });

  it('leaves no chunk row and no version row when the publish fails after the chunk copy', async () => {
    const seeded = await seed();
    const node = await nodeWithVersions(seeded, [[{ headingPath: [], body: 'never seen' }]]);
    await expect(
      publishChunks(
        app,
        seeded,
        node.nodeId,
        { versionId: node.versionIds[0] ?? '', visibility: 'protected' },
        () => Promise.reject(new Injected('after the copy')),
      ),
    ).rejects.toBeInstanceOf(Injected);
    expect(await counts(seeded)).toBe('0 0 0 0 0');
  });

  it('leaves no term row, chunk row or version row when the publish fails after the term writes', async () => {
    const seeded = await seed();
    const node = await nodeWithVersions(seeded, [
      [{ headingPath: ['Shown'], body: 'public text' }],
    ]);
    let wrote = 0;
    await expect(
      publishChunks(
        app,
        seeded,
        node.nodeId,
        { versionId: node.versionIds[0] ?? '', visibility: 'public' },
        async (tx) => {
          const { rows } = await sql<{ n: string }>`
            select count(*)::text as n from app.published_chunk_terms`.execute(tx);
          wrote = Number(rows[0]?.n ?? 0);
          throw new Injected('after the terms');
        },
      ),
    ).rejects.toBeInstanceOf(Injected);
    expect(wrote).toBeGreaterThan(0);
    expect(await counts(seeded)).toBe('0 0 0 0 0');
  });
});
