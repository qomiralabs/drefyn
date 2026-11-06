import { closeDatabase, type Database } from '@drefyn/db';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Engine, NodeId, VersionId } from '../src/index.ts';
import {
  ACTOR,
  admin,
  buildEngine,
  key,
  newNode,
  openDatabase,
  seed,
  tree,
  type Built,
  type Seeded,
} from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';

let db: Database;
let built: Built;
let engine: Engine;
let home: Seeded;

interface Row {
  readonly id: VersionId;
  readonly seq: number;
  readonly parent: VersionId | null;
  readonly sha: string;
}

const history = async (node: NodeId): Promise<readonly Row[]> => {
  const text = await admin(`
select coalesce(json_agg(json_build_object('id', id, 'seq', seq, 'parent', parent_version_id,
         'sha', encode(content_sha256, 'hex')) order by seq), '[]')
  from app.node_versions where node_id = '${node}';`);
  return JSON.parse(text) as readonly Row[];
};

const expectChain = (rows: readonly Row[]) => {
  rows.forEach((row, index) => {
    expect(row.seq).toBe(index + 1);
    expect(row.parent).toBe(index === 0 ? null : rows[index - 1]?.id);
  });
};

const saveText = async (node: NodeId, expected: VersionId | null, text: string) =>
  engine.saveDraft({
    tenant: home.tenant,
    nodeId: node,
    expectedHeadVersionId: expected,
    content: await tree(built.parse, home, text),
    origin: 'human',
    actor: ACTOR,
    idempotencyKey: key(),
  });

const op = fc.oneof(
  fc.record({ kind: fc.constant('save' as const), word: fc.stringMatching(/^[a-z]{1,8}$/) }),
  fc.record({ kind: fc.constant('rollback' as const), back: fc.nat({ max: 20 }) }),
  fc.record({ kind: fc.constant('stale' as const), word: fc.stringMatching(/^[a-z]{1,8}$/) }),
);

describeWithStack('version chains', () => {
  beforeAll(async () => {
    db = await openDatabase();
    built = buildEngine(db);
    ({ engine } = built);
    home = await seed();
  });
  afterAll(async () => {
    await closeDatabase(db);
  });

  it('rollback only ever adds, and a chain has no gaps', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), async (ops) => {
        const node = await newNode(engine, home);
        const seen: VersionId[] = [];
        const shas = new Map<VersionId, string>();
        let head: VersionId | null = null;
        for (const step of ops) {
          const before = await history(node);
          if (step.kind === 'rollback') {
            const target = seen[seen.length - 1 - (step.back % Math.max(seen.length, 1))];
            if (head === null || target === undefined) continue;
            const done = await engine.rollback({
              tenant: home.tenant,
              nodeId: node,
              toVersionId: target,
              expectedHeadVersionId: head,
              actor: ACTOR,
              idempotencyKey: key(),
            });
            if (!done.ok) throw new Error(done.error.code);
            head = done.value.versionId;
            seen.push(head);
            shas.set(head, shas.get(target) ?? '');
            const after = await history(node);
            expect(after.slice(0, before.length)).toEqual(before);
            expect(after).toHaveLength(before.length + 1);
            expect(after.at(-1)?.sha).toBe(shas.get(target));
          } else if (step.kind === 'save') {
            const done = await saveText(node, head, `${step.word}\n`);
            if (!done.ok) throw new Error(done.error.code);
            head = done.value.versionId;
            seen.push(head);
            shas.set(head, done.value.contentSha256);
          } else {
            // Any version but the head is stale, and a stale save must change nothing.
            const stale = seen.find((version) => version !== head);
            if (stale === undefined) continue;
            const done = await saveText(node, stale, `${step.word}\n`);
            expect(done).toMatchObject({ ok: false, error: { code: 'engine.version_conflict' } });
            expect(await history(node)).toEqual(before);
          }
        }
        expectChain(await history(node));
      }),
      { numRuns: 12 },
    );
  });

  it('holds under concurrent saves that each retry on conflict', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 1, max: 4 }),
        async (writers, rounds) => {
          const node = await newNode(engine, home);
          const writer = async (index: number) => {
            let done = 0;
            while (done < rounds) {
              const head = await engine.getHead(home.tenant, node);
              if (!head.ok) throw new Error(head.error.code);
              const saved = await saveText(node, head.value.versionId, `w${index} r${done}\n`);
              if (saved.ok) done += 1;
              else if (saved.error.code !== 'engine.version_conflict') {
                throw new Error(saved.error.code);
              }
            }
          };
          await Promise.all(Array.from({ length: writers }, (_, index) => writer(index)));
          const rows = await history(node);
          expect(rows).toHaveLength(writers * rounds);
          expectChain(rows);
        },
      ),
      { numRuns: 8 },
    );
  });
});
