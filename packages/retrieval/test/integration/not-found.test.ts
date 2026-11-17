import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Retrieval } from '../../src/index.ts';
import {
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  type Seeded,
  type SeededPage,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import { capturedLogger } from '../support/scripted.ts';

describeWithStack('getPage refusals', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let retrieval: Retrieval;
  let log: ReturnType<typeof capturedLogger>;
  let seeded: Seeded;
  let sibling: Seeded;
  let stranger: Seeded;
  let pages: SeededPage[];
  let siblingPage: SeededPage;
  let strangerPage: SeededPage;

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    log = capturedLogger();
    retrieval = retrievalOver(reader, { logger: log.logger });
    [seeded, sibling, stranger] = (await seedTenants([2, 1])) as [Seeded, Seeded, Seeded];
    pages = await seedPages(app, seeded, [
      {
        slug: 'open',
        versions: [{ state: 'current', chunks: [{ body: 'opencanary text anyone reads' }] }],
      },
      {
        slug: 'members',
        versions: [
          {
            state: 'current',
            visibility: 'protected',
            chunks: [{ body: 'protectedcanary text for members' }],
          },
        ],
      },
      {
        slug: 'unreleased',
        versions: [{ state: 'draft', chunks: [{ body: 'draftcanary text nobody reads' }] }],
      },
    ]);
    [siblingPage] = (await seedPages(app, sibling, [
      {
        slug: 'sibling',
        versions: [{ state: 'current', chunks: [{ body: 'siblingcanary text' }] }],
      },
    ])) as [SeededPage];
    [strangerPage] = (await seedPages(app, stranger, [
      {
        slug: 'stranger',
        versions: [{ state: 'current', chunks: [{ body: 'strangercanary text' }] }],
      },
    ])) as [SeededPage];
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  const notFound = { ok: false, error: 'retrieval.not_found' };

  it('a protected page is not_found by path and by id, and never matches', async () => {
    const page = pages[1];
    expect(await retrieval.getPage(seeded.tenant, { path: '/members' })).toEqual(notFound);
    expect(await retrieval.getPage(seeded.tenant, { nodeId: page?.nodeId ?? '' })).toEqual(
      notFound,
    );
    const result = await retrieval.retrieve(seeded.tenant, { query: 'protectedcanary members' });
    expect(result).toMatchObject({ ok: true, value: { hits: [] } });
  });

  it('a draft is not_found', async () => {
    expect(await retrieval.getPage(seeded.tenant, { path: '/unreleased' })).toEqual(notFound);
    expect(await retrieval.getPage(seeded.tenant, { nodeId: pages[2]?.nodeId ?? '' })).toEqual(
      notFound,
    );
  });

  it("another project's page is not_found, in the same organization or another", async () => {
    expect(await retrieval.getPage(seeded.tenant, { path: '/sibling' })).toEqual(notFound);
    expect(await retrieval.getPage(seeded.tenant, { nodeId: siblingPage.nodeId })).toEqual(
      notFound,
    );
    expect(await retrieval.getPage(seeded.tenant, { path: '/stranger' })).toEqual(notFound);
    expect(await retrieval.getPage(seeded.tenant, { nodeId: strangerPage.nodeId })).toEqual(
      notFound,
    );
  });

  it('a missing page is not_found too, so the refusals cannot be told apart', async () => {
    expect(await retrieval.getPage(seeded.tenant, { path: '/nowhere' })).toEqual(notFound);
  });

  it('the readable page still reads', async () => {
    expect(await retrieval.getPage(seeded.tenant, { path: '/open' })).toMatchObject({
      ok: true,
      value: { sections: [{ text: 'opencanary text anyone reads' }] },
    });
  });

  it('no query, path or chunk text ever reached a log line', async () => {
    await retrieval.retrieve(seeded.tenant, { query: 'opencanary querycanary' });
    await retrieval.retrieveScored(seeded.tenant, { query: 'opencanary querycanary' });
    const logged = JSON.stringify(log.lines);
    expect(log.lines.length).toBeGreaterThan(0);
    for (const secret of [
      'canary',
      'members',
      'unreleased',
      'sibling',
      'stranger',
      'nowhere',
      'anyone',
      '/open',
    ]) {
      expect(logged).not.toContain(secret);
    }
    for (const line of log.lines) {
      expect(line.fields['organizationId']).toBe(seeded.tenant.organizationId);
      expect(line.fields['projectId']).toBe(seeded.tenant.projectId);
    }
  });
});
