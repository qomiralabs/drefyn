import { closeDatabase, type Database } from '@drefyn/db';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Visibility } from '../../src/published-chunks.ts';
import { seed, type Seeded } from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import { openApp } from '../support/published.ts';
import {
  lexemeRows,
  nodesWithVersions,
  nodeWithVersions,
  publishChunks,
  recomputedTerms,
  storedTerms,
  type DraftChunk,
  type SeededNode,
} from '../support/terms.ts';

let app: Database;

// A small vocabulary, so pages share lexemes and document frequencies go up and down.
const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'install', 'token', 'retry', 'page'];

const chunkArb: fc.Arbitrary<DraftChunk> = fc.record({
  headingPath: fc.array(fc.constantFrom(...WORDS), { maxLength: 2 }),
  body: fc
    .array(fc.constantFrom(...WORDS, '', '!!'), { maxLength: 12 })
    .map((words) => words.join(' ')),
});

const versionArb = fc.array(chunkArb, { minLength: 0, maxLength: 4 });

type Op =
  | {
      readonly kind: 'publish';
      readonly node: number;
      readonly version: number;
      readonly visibility: Visibility;
    }
  | { readonly kind: 'unpublish'; readonly node: number };

const NODES = 3;
const VERSIONS = 3;

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('publish' as const),
      node: fc.integer({ min: 0, max: NODES - 1 }),
      version: fc.integer({ min: 0, max: VERSIONS - 1 }),
      visibility: fc.constantFrom<Visibility>('public', 'protected'),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('unpublish' as const),
      node: fc.integer({ min: 0, max: NODES - 1 }),
    }),
  },
);

// Republishing the version a node already has at the other visibility is a tighten or a widen,
// so the sequence covers all five moves without naming them apart.
async function apply(seeded: Seeded, nodes: readonly SeededNode[], op: Op) {
  const node = nodes[op.node];
  if (node === undefined) throw new Error('no node');
  if (op.kind === 'unpublish') {
    await publishChunks(app, seeded, node.nodeId, null);
    return;
  }
  const versionId = node.versionIds[op.version];
  if (versionId === undefined) throw new Error('no version');
  await publishChunks(app, seeded, node.nodeId, { versionId, visibility: op.visibility });
}

describeWithStack('term statistics written by publish', () => {
  beforeAll(async () => {
    app = await openApp();
  });

  afterAll(async () => {
    await closeDatabase(app);
  });

  it('equal a full recompute from public current chunks after any sequence of moves', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(versionArb, { minLength: VERSIONS, maxLength: VERSIONS }), {
          minLength: NODES,
          maxLength: NODES,
        }),
        fc.array(opArb, { minLength: 1, maxLength: 10 }),
        async (pages, ops) => {
          const seeded = await seed();
          const nodes = await nodesWithVersions(seeded, pages);
          for (const op of ops) {
            await apply(seeded, nodes, op);
            expect(await storedTerms(app, seeded.tenant)).toEqual(
              await recomputedTerms(app, seeded.tenant),
            );
          }
        },
      ),
      { numRuns: 30 },
    );
  });

  it('keeps a lexeme that appears only on a protected page or a draft out of every term table', async () => {
    const seeded = await seed();
    const protectedWord = `zzprotected${seeded.project.slice(0, 8)}`;
    const draftWord = `zzdraft${seeded.project.slice(0, 8)}`;
    const shown = await nodeWithVersions(seeded, [
      [{ headingPath: ['Shown'], body: 'public words only' }],
      [{ headingPath: ['Shown'], body: `public words and ${draftWord}` }],
    ]);
    const hidden = await nodeWithVersions(seeded, [
      [{ headingPath: ['Hidden'], body: `secret ${protectedWord} public` }],
    ]);
    await publishChunks(app, seeded, shown.nodeId, {
      versionId: shown.versionIds[0] ?? '',
      visibility: 'public',
    });
    await publishChunks(app, seeded, hidden.nodeId, {
      versionId: hidden.versionIds[0] ?? '',
      visibility: 'protected',
    });
    expect(await lexemeRows(protectedWord)).toBe(0);
    expect(await lexemeRows(draftWord)).toBe(0);
    expect(await lexemeRows('secret')).toBe(0);
    // Widening shows it, and tightening again takes every trace back out.
    await publishChunks(app, seeded, hidden.nodeId, {
      versionId: hidden.versionIds[0] ?? '',
      visibility: 'public',
    });
    expect(await lexemeRows(protectedWord)).toBe(2);
    await publishChunks(app, seeded, hidden.nodeId, {
      versionId: hidden.versionIds[0] ?? '',
      visibility: 'protected',
    });
    expect(await lexemeRows(protectedWord)).toBe(0);
    expect(await storedTerms(app, seeded.tenant)).toEqual(
      await recomputedTerms(app, seeded.tenant),
    );
  });

  it('lets two publishes in one project commit together without a deadlock and leaves correct counts', async () => {
    const seeded = await seed();
    // Many shared lexemes in opposite orders, so a lock taken per lexeme would cross.
    const forward = WORDS.join(' ');
    const backward = [...WORDS].reverse().join(' ');
    const pairs = 12;
    const nodes = await nodesWithVersions(
      seeded,
      Array.from({ length: pairs * 2 }, (_, at) => [
        [
          { headingPath: [], body: at % 2 === 0 ? forward : backward },
          { headingPath: ['More'], body: `${backward} n${String(at)}` },
        ],
      ]),
    );
    for (let at = 0; at < pairs; at += 1) {
      const [left, right] = [nodes[at * 2], nodes[at * 2 + 1]];
      if (left === undefined || right === undefined) throw new Error('no node');
      const results = await Promise.allSettled([
        publishChunks(app, seeded, left.nodeId, {
          versionId: left.versionIds[0] ?? '',
          visibility: 'public',
        }),
        publishChunks(app, seeded, right.nodeId, {
          versionId: right.versionIds[0] ?? '',
          visibility: 'public',
        }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    }
    const stored = await storedTerms(app, seeded.tenant);
    expect(stored).toEqual(await recomputedTerms(app, seeded.tenant));
    expect(stored.totals).toEqual([
      expect.stringMatching(new RegExp(`^latest ${String(pairs * 4)} `)),
    ]);
    expect(stored.stats).toContain(`latest alpha ${String(pairs * 4)}`);
  });
});
