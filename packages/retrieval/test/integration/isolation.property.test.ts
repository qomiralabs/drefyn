import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Retrieval } from '../../src/index.ts';
import {
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  type PageSpec,
  type Seeded,
  type SeededPage,
  type VersionSpec,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

// Each page holds a canary word no other page has, plus words every page shares, so a query
// for everything reaches every row a leak could come from.
type Shape = 'public' | 'protected' | 'old' | 'draft' | 'old-then-protected';

const versionsFor = (shape: Shape, canary: string, live: string): VersionSpec[] => {
  const chunks = [{ heading: ['Shared'], body: `shared words ${canary}` }];
  switch (shape) {
    case 'public':
      return [{ state: 'current', chunks }];
    case 'protected':
      return [{ state: 'current', visibility: 'protected', chunks }];
    case 'old':
      return [
        { state: 'old', chunks },
        { state: 'current', chunks: [{ body: `shared words ${live}` }] },
      ];
    case 'draft':
      return [{ state: 'draft', chunks }];
    case 'old-then-protected':
      return [
        { state: 'old', chunks },
        { state: 'current', visibility: 'protected', chunks: [{ body: `shared ${canary}x` }] },
      ];
  }
};

interface Planted {
  readonly owner: Seeded;
  readonly shape: Shape;
  readonly canary: string;
  readonly live: string;
  readonly page: SeededPage;
}

describeWithStack('isolation', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let retrieval: Retrieval;

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    retrieval = retrievalOver(reader);
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  it('never returns a draft, a protected page, an old version or another tenant', async () => {
    const shape = fc.constantFrom<Shape>(
      'public',
      'protected',
      'old',
      'draft',
      'old-then-protected',
    );
    await fc.assert(
      fc.asyncProperty(
        // Two organizations; the first has two projects, so a sibling project is in play too.
        fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), shape), { minLength: 1, maxLength: 9 }),
        fc.integer({ min: 1, max: 20 }),
        async (plan, limit) => {
          const tenants = await seedTenants([2, 1]);
          const run = Math.random().toString(36).slice(2, 8);
          const planted: Planted[] = [];
          for (const [at, owner] of tenants.entries()) {
            const mine = plan
              .map(([who, s], n) => ({
                who,
                s,
                canary: `canary${run}n${String(n)}`,
                live: `live${run}n${String(n)}`,
              }))
              .filter((p) => p.who === at);
            const specs: PageSpec[] = mine.map((p) => ({
              slug: p.canary,
              versions: versionsFor(p.s, p.canary, p.live),
            }));
            const pages = await seedPages(app, owner, specs);
            mine.forEach((p, n) => {
              const page = pages[n];
              if (page !== undefined)
                planted.push({ owner, shape: p.s, canary: p.canary, live: p.live, page });
            });
          }
          // Every unique word, so each readable chunk has a rare word that picks it.
          const everyWord = planted.map((p) => `${p.canary} ${p.live}`).join(' ');
          for (const owner of tenants) {
            const visible = planted.filter((p) => p.owner === owner && p.shape !== 'draft');
            const allowed = new Set(
              visible.flatMap((p) =>
                p.page.versions
                  .filter((v) => v.state === 'current' && v.visibility === 'public')
                  .flatMap((v) => v.chunkIds),
              ),
            );
            const forbidden = planted
              .filter((p) => p.owner !== owner || p.shape !== 'public')
              .map((p) => p.canary);
            const result = await retrieval.retrieve(owner.tenant, {
              query: `shared words ${everyWord}`,
              limit,
            });
            if (!result.ok) {
              // Nothing public and current in this project: there is no latest to read.
              expect(result.error).toBe('retrieval.version_not_found');
              expect(allowed.size).toBe(0);
              continue;
            }
            for (const hit of result.value.hits) {
              expect(allowed.has(hit.chunkId)).toBe(true);
              for (const canary of forbidden) expect(hit.text).not.toContain(canary);
            }
            expect(result.value.hits.length).toBe(Math.min(limit, allowed.size));
            for (const p of planted) {
              const got = await retrieval.getPage(owner.tenant, { nodeId: p.page.nodeId });
              const readable = p.owner === owner && p.shape === 'public';
              if (!readable) {
                expect(got).toEqual({ ok: false, error: 'retrieval.not_found' });
                const byPath = await retrieval.getPage(owner.tenant, { path: p.page.path });
                expect(byPath).toEqual({ ok: false, error: 'retrieval.not_found' });
              } else {
                expect(got.ok).toBe(true);
              }
            }
          }
        },
      ),
      { numRuns: 15 },
    );
  });
});
