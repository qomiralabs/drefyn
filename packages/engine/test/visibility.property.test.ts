import { closeDatabase, withTenant, type Database, type PublishedDatabase } from '@drefyn/db';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { MovingActor, Visibility } from '../src/index.ts';
import { admin, buildEngine, key, seed, type Built, type Seeded } from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';
import { openApp, openReader } from './support/published.ts';
import { recomputedTerms, storedTerms } from './support/terms.ts';
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
  type Page,
} from './support/visibility.ts';

// Over random trees and random sequences of publishes, restores, overrides, site defaults,
// moves and plan changes by every kind of actor, no node the tree ever shut is readable by the
// public reader unless a person who may publish opened it since. The oracle recomputes
// inheritance from the raw tree columns, independently of the engine's SQL.

let app: Database;
let readerDb: PublishedDatabase;
let built: Built;

const NODES = 5;
const MAX_LEVELS = 64;

type ActorName = 'editor' | 'viewer' | 'key' | 'git' | 'job';
const ACTORS: Readonly<Record<ActorName, MovingActor>> = {
  editor: EDITOR,
  viewer: VIEWER,
  key: KEY,
  git: GIT,
  job: JOB,
};

type Op =
  | {
      readonly kind: 'publish';
      readonly node: number;
      readonly version: 0 | 1;
      readonly by: ActorName;
    }
  | {
      readonly kind: 'override';
      readonly node: number;
      readonly override: Visibility | null;
      readonly by: ActorName;
    }
  | { readonly kind: 'default'; readonly visibility: Visibility; readonly by: ActorName }
  | {
      readonly kind: 'move';
      readonly node: number;
      readonly parent: number | null;
      readonly by: ActorName;
    }
  | { readonly kind: 'plan'; readonly readOnly: boolean; readonly tier: 'free' | 'self_hosted' };

const node = fc.integer({ min: 0, max: NODES - 1 });
const by = fc.constantFrom<ActorName>('editor', 'viewer', 'key', 'git', 'job');
const visibility = fc.constantFrom<Visibility>('public', 'protected');

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('publish' as const),
      node,
      version: fc.constantFrom<0 | 1>(0, 1),
      by,
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('override' as const),
      node,
      override: fc.constantFrom<Visibility | null>('public', 'protected', null),
      by,
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('default' as const), visibility, by }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('move' as const),
      node,
      parent: fc.option(node, { nil: null }),
      by,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('plan' as const),
      readOnly: fc.boolean(),
      tier: fc.constantFrom<'free' | 'self_hosted'>('free', 'self_hosted'),
    }),
  },
);

// Each node's parent is an earlier node or none, so every generated tree is a forest.
const treeArb = fc.tuple(
  ...Array.from({ length: NODES }, (_, at) =>
    at === 0 ? fc.constant(null) : fc.option(fc.integer({ min: 0, max: at - 1 }), { nil: null }),
  ),
);

interface TreeRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly visibility_override: string | null;
}

// Inheritance as the product promises it, from the stored columns alone.
async function effectiveByNode(seeded: Seeded): Promise<ReadonlyMap<string, Visibility>> {
  const { rows, site } = await withTenant(app, seeded.tenant, async (tx) => ({
    rows: (
      await sql<TreeRow>`
        select id::text, parent_id::text, visibility_override from app.nodes`.execute(tx)
    ).rows,
    site: (
      await sql<{ default_visibility: string }>`
        select default_visibility from app.site_access`.execute(tx)
    ).rows[0]?.default_visibility,
  }));
  const fallback: Visibility = site === 'protected' ? 'protected' : 'public';
  const byId = new Map(rows.map((row) => [row.id, row]));
  const effective = new Map<string, Visibility>();
  for (const row of rows) {
    let at: TreeRow | undefined = row;
    let answer: Visibility | undefined;
    for (let level = 0; at !== undefined && level < MAX_LEVELS; level += 1) {
      if (at.visibility_override !== null) {
        answer = at.visibility_override === 'protected' ? 'protected' : 'public';
        break;
      }
      if (at.parent_id === null) {
        answer = fallback;
        break;
      }
      at = byId.get(at.parent_id);
    }
    effective.set(row.id, answer ?? 'protected');
  }
  return effective;
}

const plan = (seeded: Seeded, op: Extract<Op, { kind: 'plan' }>) =>
  admin(`
update app.organizations set plan_tier = '${op.tier}',
       read_only_since = ${op.readOnly ? 'now()' : 'null'}
 where organization_id = '${seeded.organization}';`);

interface Outcome {
  readonly ok: boolean;
  readonly widened: boolean;
}

async function apply(seeded: Seeded, pages: readonly Page[], op: Op): Promise<Outcome> {
  const { engine } = built;
  const tenant = seeded.tenant;
  const at = (index: number) => {
    const found = pages[index];
    if (found === undefined) throw new Error('no such page');
    return found;
  };
  switch (op.kind) {
    case 'publish': {
      const target = at(op.node);
      const done = await engine.publish({
        tenant,
        nodeId: target.nodeId,
        versionId: target.versionIds[op.version] ?? target.head,
        expectedHeadVersionId: target.head,
        actor: ACTORS[op.by],
        idempotencyKey: key(),
      });
      return { ok: done.ok, widened: false };
    }
    case 'override': {
      const done = await engine.setVisibility({
        tenant,
        nodeId: at(op.node).nodeId,
        override: op.override,
        actor: ACTORS[op.by],
        idempotencyKey: key(),
      });
      return { ok: done.ok, widened: done.ok && done.value.widened };
    }
    case 'default': {
      const done = await engine.setDefaultVisibility({
        tenant,
        visibility: op.visibility,
        actor: ACTORS[op.by],
        idempotencyKey: key(),
      });
      return { ok: done.ok, widened: done.ok && done.value.widened };
    }
    case 'move': {
      const done = await engine.moveNode({
        tenant,
        nodeId: at(op.node).nodeId,
        parentId: op.parent === null ? null : at(op.parent).nodeId,
        afterId: null,
        actor: ACTORS[op.by],
      });
      return { ok: done.ok, widened: false };
    }
    case 'plan':
      await plan(seeded, op);
      return { ok: true, widened: false };
  }
}

const opensByPerson = (op: Op) =>
  (op.kind === 'override' || op.kind === 'default') && op.by === 'editor';

describeWithStack('visibility over random histories', () => {
  beforeAll(async () => {
    app = await openApp();
    readerDb = await openReader();
    built = buildEngine(app);
  });

  afterAll(async () => {
    await closeDatabase(readerDb);
    await closeDatabase(app);
  });

  it('never lets the public reader see a node the tree shut, unless a person opened it', async () => {
    const bystander = await seed();
    const bystanderPage = await page(bystander);
    const bystanderReceipt = await built.engine.publish({
      tenant: bystander.tenant,
      nodeId: bystanderPage.nodeId,
      versionId: bystanderPage.head,
      expectedHeadVersionId: bystanderPage.head,
      actor: EDITOR,
      idempotencyKey: key(),
    });
    expect(bystanderReceipt.ok).toBe(true);

    await fc.assert(
      fc.asyncProperty(
        treeArb,
        fc.array(opArb, { minLength: 4, maxLength: 16 }),
        async (tree, ops) => {
          const seeded = await seed();
          await openWorkflow(seeded);
          const pages: Page[] = [];
          for (const parent of tree) {
            const parentPage = parent === null ? undefined : pages[parent];
            pages.push(
              await page(seeded, parentPage === undefined ? {} : { parentId: parentPage.nodeId }),
            );
          }
          const shut = new Set<string>();
          let before = await effectiveByNode(seeded);
          for (const op of ops) {
            const outcome = await apply(seeded, pages, op);
            // Only a person who may publish ever reports a widening.
            if (outcome.widened) expect('by' in op ? op.by : 'none').toBe('editor');
            const after = await effectiveByNode(seeded);
            for (const [id, value] of after) {
              if (value === 'protected') shut.add(id);
              // Opened by this very step, and by a person: anything else that turns a shut node
              // public in the tree has no one to vouch for it, so it stays shut here.
              else if (outcome.widened && opensByPerson(op) && before.get(id) === 'protected') {
                shut.delete(id);
              }
            }
            before = after;
            const view = await publicView(readerDb, seeded);
            const readable = new Set([
              ...view.versions,
              ...view.filters,
              ...view.chunks,
              ...(await postedNodes(seeded)),
            ]);
            for (const id of readable) expect(shut.has(id), `${id} after ${op.kind}`).toBe(false);
            expect(await storedTerms(app, seeded.tenant)).toEqual(
              await recomputedTerms(app, seeded.tenant),
            );
          }
          expect((await publicView(readerDb, bystander)).versions).toEqual([bystanderPage.nodeId]);
        },
      ),
      {
        numRuns: 20,
        // The known ways in, always tried: a child moved out of a shut branch and published by
        // a push and a person, before and after its first publish; an old version restored by a
        // key; a shut site opened by a key.
        examples: [
          [
            [null, 0, null, null, null],
            [
              { kind: 'override', node: 0, override: 'protected', by: 'git' },
              { kind: 'publish', node: 1, version: 1, by: 'editor' },
              { kind: 'move', node: 1, parent: null, by: 'git' },
              { kind: 'publish', node: 1, version: 1, by: 'git' },
              { kind: 'publish', node: 1, version: 0, by: 'editor' },
            ],
          ],
          [
            [null, 0, 1, null, null],
            [
              { kind: 'override', node: 0, override: 'protected', by: 'key' },
              { kind: 'move', node: 1, parent: 3, by: 'job' },
              { kind: 'publish', node: 2, version: 1, by: 'git' },
              { kind: 'publish', node: 1, version: 1, by: 'editor' },
            ],
          ],
          [
            [null, null, null, null, null],
            [
              { kind: 'publish', node: 2, version: 1, by: 'key' },
              { kind: 'override', node: 2, override: 'protected', by: 'key' },
              { kind: 'publish', node: 2, version: 0, by: 'key' },
              { kind: 'override', node: 2, override: null, by: 'key' },
              { kind: 'publish', node: 2, version: 1, by: 'editor' },
            ],
          ],
          [
            [null, 0, 1, null, null],
            [
              { kind: 'default', visibility: 'protected', by: 'git' },
              { kind: 'publish', node: 2, version: 1, by: 'editor' },
              { kind: 'default', visibility: 'public', by: 'key' },
              { kind: 'plan', readOnly: true, tier: 'free' },
              { kind: 'default', visibility: 'public', by: 'editor' },
              { kind: 'plan', readOnly: false, tier: 'free' },
              { kind: 'publish', node: 2, version: 0, by: 'git' },
            ],
          ],
        ],
      },
    );
  }, 900_000);
});
