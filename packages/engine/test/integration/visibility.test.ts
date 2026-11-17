import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, Engine, Visibility } from '../../src/index.ts';
import { admin, buildEngine, key, seed, type Built, type Seeded } from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import { openApp, openReader } from '../support/published.ts';
import { recomputedTerms, storedTerms } from '../support/terms.ts';
import {
  EDITOR,
  GIT,
  JOB,
  KEY,
  VIEWER,
  openWorkflow,
  page,
  postedNodes,
  publicView,
  storedVisibility,
  type Page,
} from '../support/visibility.ts';

let app: Database;
let readerDb: PublishedDatabase;
let built: Built;

const publish = (engine: Engine, seeded: Seeded, at: Page, actor: Actor = EDITOR, version = 1) =>
  engine.publish({
    tenant: seeded.tenant,
    nodeId: at.nodeId,
    versionId: at.versionIds[version] ?? at.head,
    expectedHeadVersionId: at.head,
    actor,
    idempotencyKey: key(),
  });

const published = async (engine: Engine, seeded: Seeded, at: Page, actor?: Actor) => {
  const done = await publish(engine, seeded, at, actor);
  if (!done.ok) throw new Error(`publish refused: ${done.error.code}`);
  return done.value;
};

const setOverride = (
  engine: Engine,
  seeded: Seeded,
  at: Page,
  override: Visibility | null,
  actor: Actor = EDITOR,
  idempotencyKey = key(),
) =>
  engine.setVisibility({
    tenant: seeded.tenant,
    nodeId: at.nodeId,
    override,
    actor,
    idempotencyKey,
  });

const shut = async (seeded: Seeded, at: Page) => {
  const done = await setOverride(built.engine, seeded, at, 'protected');
  if (!done.ok) throw new Error(`tighten refused: ${done.error.code}`);
  return done.value;
};

const termsMatch = async (seeded: Seeded) => {
  expect(await storedTerms(app, seeded.tenant)).toEqual(await recomputedTerms(app, seeded.tenant));
};

// A protected branch: a parent shut by a person, and a published child that follows it.
async function shutBranch(seeded: Seeded) {
  const parent = await page(seeded, { slug: 'internal' });
  const child = await page(seeded, { slug: 'runbook', parentId: parent.nodeId });
  await shut(seeded, parent);
  await published(built.engine, seeded, child);
  return { parent, child };
}

describeWithStack('visibility', () => {
  beforeAll(async () => {
    app = await openApp();
    readerDb = await openReader();
    built = buildEngine(app);
  });

  afterAll(async () => {
    await closeDatabase(readerDb);
    await closeDatabase(app);
  });

  describe('inheritance', () => {
    it('publishes a child of a protected parent protected in every table, and only that tenant', async () => {
      const shutTenant = await seed();
      const openTenant = await seed();
      const { child } = await shutBranch(shutTenant);
      const openParent = await page(openTenant, { slug: 'internal' });
      const openChild = await page(openTenant, { slug: 'runbook', parentId: openParent.nodeId });
      const receipt = await published(built.engine, openTenant, openChild);
      expect(receipt.visibility).toBe('public');

      expect(await storedVisibility(child.nodeId)).toBe('protected protected protected');
      expect(await publicView(readerDb, shutTenant)).toEqual({
        versions: [],
        filters: [],
        chunks: [],
      });
      expect(await postedNodes(shutTenant)).toEqual([]);
      await termsMatch(shutTenant);

      const nodeIds = [openChild.nodeId as string];
      expect(await publicView(readerDb, openTenant)).toEqual({
        versions: nodeIds,
        filters: nodeIds,
        chunks: nodeIds,
      });
      expect(await postedNodes(openTenant)).toEqual(nodeIds);
    });

    it('lets a child override a protected parent only through a person', async () => {
      const seeded = await seed();
      const { child } = await shutBranch(seeded);
      const opened = await setOverride(built.engine, seeded, child, 'public');
      expect(opened.ok && opened.value).toMatchObject({ effective: 'public', widened: true });
      expect((await publicView(readerDb, seeded)).versions).toEqual([child.nodeId]);
      await termsMatch(seeded);
    });

    it('cannot be reached from another tenant', async () => {
      const owner = await seed();
      const stranger = await seed();
      const { child } = await shutBranch(owner);
      const done = await built.engine.setVisibility({
        tenant: stranger.tenant,
        nodeId: child.nodeId,
        override: 'public',
        actor: EDITOR,
        idempotencyKey: key(),
      });
      expect(done.ok || done.error.code).toBe('engine.not_found');
      expect(await storedVisibility(child.nodeId)).toBe('protected protected protected');
    });
  });

  describe('tightening', () => {
    it('flips every published row of the subtree and takes its words out of the term tables', async () => {
      const seeded = await seed();
      const other = await seed();
      const parent = await page(seeded, { slug: 'guides' });
      const child = await page(seeded, { slug: 'install', parentId: parent.nodeId });
      const otherPage = await page(other, { slug: 'guides' });
      await published(built.engine, seeded, parent);
      await published(built.engine, seeded, child);
      await published(built.engine, other, otherPage);
      expect(await postedNodes(seeded)).toEqual([parent.nodeId, child.nodeId].sort());

      const change = await shut(seeded, parent);
      expect(change).toMatchObject({ effective: 'protected', widened: false, nodesChanged: 2 });
      expect(await publicView(readerDb, seeded)).toEqual({ versions: [], filters: [], chunks: [] });
      expect(await postedNodes(seeded)).toEqual([]);
      expect(await storedVisibility(child.nodeId)).toBe('protected protected protected');
      await termsMatch(seeded);
      expect((await publicView(readerDb, other)).versions).toEqual([otherPage.nodeId]);
      await termsMatch(other);
    });

    it.each<[string, Actor]>([
      ['a key the project allows', KEY],
      ['a push the project allows', GIT],
    ])('is open to %s', async (_name, actor) => {
      const seeded = await seed();
      await openWorkflow(seeded);
      const at = await page(seeded);
      await published(built.engine, seeded, at);
      const done = await setOverride(built.engine, seeded, at, 'protected', actor);
      expect(done.ok).toBe(true);
      expect((await publicView(readerDb, seeded)).versions).toEqual([]);
    });

    it('is refused to a job and to a person who may not publish', async () => {
      const seeded = await seed();
      await openWorkflow(seeded);
      const at = await page(seeded);
      await published(built.engine, seeded, at);
      for (const actor of [JOB, VIEWER]) {
        const done = await setOverride(built.engine, seeded, at, 'protected', actor);
        expect(done.ok || done.error.code).toBe('engine.forbidden');
      }
      expect((await publicView(readerDb, seeded)).versions).toEqual([at.nodeId]);
    });
  });

  describe('widening', () => {
    it.each<[string, Actor]>([
      ['a key', KEY],
      ['a push', GIT],
      ['a job', JOB],
      ['a viewer', VIEWER],
    ])('is refused to %s even where the project lets it publish', async (_name, actor) => {
      const seeded = await seed();
      await openWorkflow(seeded);
      const { parent, child } = await shutBranch(seeded);
      for (const override of ['public', null] as const) {
        const done = await setOverride(built.engine, seeded, parent, override, actor);
        expect(done.ok || done.error.code).toBe('engine.widen_requires_publish');
      }
      const direct = await setOverride(built.engine, seeded, child, 'public', actor);
      expect(direct.ok || direct.error.code).toBe('engine.widen_requires_publish');
      expect(await publicView(readerDb, seeded)).toEqual({ versions: [], filters: [], chunks: [] });
    });

    it('opens the whole branch for a person who may publish', async () => {
      const seeded = await seed();
      const { parent, child } = await shutBranch(seeded);
      await published(built.engine, seeded, parent);
      const done = await setOverride(built.engine, seeded, parent, null);
      expect(done.ok && done.value).toMatchObject({
        effective: 'public',
        widened: true,
        nodesChanged: 2,
      });
      expect((await publicView(readerDb, seeded)).chunks).toEqual(
        [parent.nodeId, child.nodeId].sort(),
      );
      await termsMatch(seeded);
    });
  });

  describe('nothing else widens', () => {
    it('a move out of a protected branch pins the node, so a push after it stays protected', async () => {
      const seeded = await seed();
      await openWorkflow(seeded);
      const { child } = await shutBranch(seeded);
      const moved = await built.engine.moveNode({
        tenant: seeded.tenant,
        nodeId: child.nodeId,
        parentId: null,
        afterId: null,
        actor: GIT,
      });
      expect(moved.ok).toBe(true);
      expect(
        (
          await admin(`select visibility_override from app.nodes where id = '${child.nodeId}';`)
        ).trim(),
      ).toBe('protected');
      const receipt = await published(built.engine, seeded, child, GIT);
      expect(receipt.visibility).toBe('protected');
      expect(await publicView(readerDb, seeded)).toEqual({ versions: [], filters: [], chunks: [] });
    });

    it('a restore of an older version by a key stays protected', async () => {
      const seeded = await seed();
      await openWorkflow(seeded);
      const { child } = await shutBranch(seeded);
      const restored = await publish(built.engine, seeded, child, KEY, 0);
      expect(restored.ok && restored.value).toMatchObject({
        versionId: child.versionIds[0],
        visibility: 'protected',
      });
      expect(await storedVisibility(child.nodeId)).toBe('protected protected protected');
      expect(await postedNodes(seeded)).toEqual([]);
    });

    it('a publish of rows a tree no longer shuts keeps them protected', async () => {
      const seeded = await seed();
      const { parent, child } = await shutBranch(seeded);
      // Outside the engine on purpose: no engine path leaves the tree public over protected rows.
      await admin(`update app.nodes set visibility_override = null where id = '${parent.nodeId}';`);
      const receipt = await published(built.engine, seeded, child);
      expect(receipt.visibility).toBe('protected');
      expect(await publicView(readerDb, seeded)).toEqual({ versions: [], filters: [], chunks: [] });
    });

    it('a downgrade leaves protected pages protected and read only, and never public', async () => {
      const seeded = await seed();
      const { child } = await shutBranch(seeded);
      await admin(
        `update app.organizations set read_only_since = now() where organization_id = '${seeded.organization}';`,
      );
      const opened = await setOverride(built.engine, seeded, child, 'public');
      expect(opened.ok || opened.error.code).toBe('engine.read_only');
      const again = await publish(built.engine, seeded, child);
      expect(again.ok || again.error.code).toBe('publish.read_only');
      expect(await publicView(readerDb, seeded)).toEqual({ versions: [], filters: [], chunks: [] });

      // Down to the smallest plan and writable again: still shut.
      await admin(`
update app.organizations set read_only_since = null, plan_tier = 'free'
 where organization_id = '${seeded.organization}';`);
      const receipt = await published(built.engine, seeded, child);
      expect(receipt.visibility).toBe('protected');
      expect(await publicView(readerDb, seeded)).toEqual({ versions: [], filters: [], chunks: [] });
      expect(await storedVisibility(child.nodeId)).toBe('protected protected protected');
    });
  });

  describe('the site default', () => {
    it('shuts every page with no override, and only a person opens it again', async () => {
      const seeded = await seed();
      await openWorkflow(seeded);
      const first = await page(seeded, { slug: 'one' });
      const second = await page(seeded, { slug: 'two' });
      await published(built.engine, seeded, first);
      await published(built.engine, seeded, second);
      const pinnedOpen = await page(seeded, { slug: 'three' });
      expect((await setOverride(built.engine, seeded, pinnedOpen, 'public')).ok).toBe(true);
      await published(built.engine, seeded, pinnedOpen);

      const shutSite = await built.engine.setDefaultVisibility({
        tenant: seeded.tenant,
        visibility: 'protected',
        actor: KEY,
        idempotencyKey: key(),
      });
      expect(shutSite.ok && shutSite.value).toMatchObject({ nodeId: null, nodesChanged: 2 });
      expect((await publicView(readerDb, seeded)).versions).toEqual([pinnedOpen.nodeId]);
      await termsMatch(seeded);

      const fresh = await page(seeded, { slug: 'four' });
      expect((await published(built.engine, seeded, fresh)).visibility).toBe('protected');

      for (const actor of [KEY, GIT, JOB, VIEWER]) {
        const refused = await built.engine.setDefaultVisibility({
          tenant: seeded.tenant,
          visibility: 'public',
          actor,
          idempotencyKey: key(),
        });
        expect(refused.ok || refused.error.code).toBe('engine.widen_requires_publish');
      }
      const opened = await built.engine.setDefaultVisibility({
        tenant: seeded.tenant,
        visibility: 'public',
        actor: EDITOR,
        idempotencyKey: key(),
      });
      expect(opened.ok && opened.value).toMatchObject({ widened: true, nodesChanged: 3 });
      expect((await publicView(readerDb, seeded)).versions).toHaveLength(4);
      await termsMatch(seeded);
    });
  });

  describe('idempotency', () => {
    it('repeats the same key safely and refuses it for anything else', async () => {
      const seeded = await seed();
      const at = await page(seeded);
      await published(built.engine, seeded, at);
      const once = key();
      const first = await setOverride(built.engine, seeded, at, 'protected', EDITOR, once);
      const second = await setOverride(built.engine, seeded, at, 'protected', EDITOR, once);
      expect(first.ok).toBe(true);
      expect(second).toEqual(first);
      const other = await setOverride(built.engine, seeded, at, null, EDITOR, once);
      expect(other.ok || other.error.code).toBe('engine.idempotency_conflict');
      const rows = await admin(
        `select count(*) || ' ' || string_agg(actor_kind || ':' || actor_id, ',')
           from app.visibility_log where project_id = '${seeded.project}';`,
      );
      expect(rows.trim()).toBe(`1 user:${EDITOR.kind === 'user' ? EDITOR.userId : ''}`);
      expect(await storedVisibility(at.nodeId)).toBe('protected protected protected');
    });

    it('keeps the log append only for the application role', async () => {
      const seeded = await seed();
      const at = await page(seeded);
      await shut(seeded, at);
      const refused = await admin(`
select has_table_privilege('drefyn_app', 'app.visibility_log', 'update') || ' ' ||
       has_table_privilege('drefyn_app', 'app.visibility_log', 'delete');`);
      expect(refused.trim()).toBe('false false');
    });
  });

  describe('docs.private_access off', () => {
    it('refuses every change, and a publish still keeps protected pages protected', async () => {
      const seeded = await seed();
      const { child } = await shutBranch(seeded);
      const off = buildEngine(app, {
        flags: {
          evaluate: (name) => Promise.resolve({ value: name !== 'docs.private_access' }),
        },
      });
      for (const override of ['public', 'protected', null] as const) {
        const done = await setOverride(off.engine, seeded, child, override);
        expect(done.ok || done.error.code).toBe('engine.forbidden');
      }
      const receipt = await published(off.engine, seeded, child);
      expect(receipt.visibility).toBe('protected');
      expect(await publicView(readerDb, seeded)).toEqual({ versions: [], filters: [], chunks: [] });
    });
  });
});
