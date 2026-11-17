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

describeWithStack('versions', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let retrieval: Retrieval;
  let seeded: Seeded;
  let empty: Seeded;
  let page: SeededPage;

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    retrieval = retrievalOver(reader);
    [seeded, empty] = (await seedTenants([2])) as [Seeded, Seeded];
    // One page published twice and then edited: v1 is an older published version, v2 is
    // current, v3 is a draft. Each version's text has a word only it holds.
    [page] = (await seedPages(app, seeded, [
      {
        slug: 'install',
        versions: [
          { state: 'old', chunks: [{ heading: ['Install'], body: 'install oldcanary steps' }] },
          {
            state: 'current',
            chunks: [
              { heading: ['Install'], body: 'install currentcanary steps' },
              { heading: ['Install', 'Verify'], body: 'verify the install' },
            ],
          },
          { state: 'draft', chunks: [{ heading: ['Install'], body: 'install draftcanary steps' }] },
        ],
      },
    ])) as [SeededPage];
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  const current = () => page.versions[1];

  it('latest returns only the current published version', async () => {
    const result = await retrieval.retrieve(seeded.tenant, {
      query: 'install oldcanary currentcanary draftcanary',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pin.version).toBe('latest');
    expect(result.value.hits.length).toBeGreaterThan(0);
    for (const hit of result.value.hits) {
      expect(hit.versionId).toBe(current()?.versionId);
      expect(current()?.chunkIds).toContain(hit.chunkId);
      expect(hit.text).not.toMatch(/oldcanary|draftcanary/);
    }
    expect(result.value.hits.map((h) => h.text)).toContain('install currentcanary steps');
  });

  it('an older published version and a draft never match, even alone', async () => {
    for (const query of ['oldcanary', 'draftcanary']) {
      expect(await retrieval.retrieve(seeded.tenant, { query })).toMatchObject({
        ok: true,
        value: { hits: [] },
      });
    }
  });

  it('the pin is the newest publish in the set', async () => {
    const result = await retrieval.retrieve(seeded.tenant, { query: 'verify' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Date(result.value.pin.publishedAt).toISOString()).toBe(result.value.pin.publishedAt);
    const page = await retrieval.getPage(seeded.tenant, { path: '/install' });
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.value.pin.publishedAt).toBe(result.value.pin.publishedAt);
  });

  it('getPage for latest reads the current version only', async () => {
    const result = await retrieval.getPage(seeded.tenant, { nodeId: page.nodeId });
    expect(result).toMatchObject({
      ok: true,
      value: {
        pin: { version: 'latest' },
        nodeId: page.nodeId,
        versionId: current()?.versionId,
        path: '/install',
        title: 'install',
        sections: [
          { headingPath: ['Install'], text: 'install currentcanary steps' },
          { headingPath: ['Install', 'Verify'], text: 'verify the install' },
        ],
      },
    });
  });

  it('any label but latest is version_not_found, on every call', async () => {
    for (const version of ['v1', 'v2', 'Latest', 'next']) {
      expect(await retrieval.retrieve(seeded.tenant, { query: 'install', version })).toEqual({
        ok: false,
        error: 'retrieval.version_not_found',
      });
      expect(await retrieval.getPage(seeded.tenant, { path: '/install', version })).toEqual({
        ok: false,
        error: 'retrieval.version_not_found',
      });
    }
  });

  it('a project with nothing published has no latest', async () => {
    expect(await retrieval.retrieve(empty.tenant, { query: 'install' })).toEqual({
      ok: false,
      error: 'retrieval.version_not_found',
    });
  });

  it('lists latest as the one version', async () => {
    expect(await retrieval.listVersions(seeded.tenant)).toEqual({
      ok: true,
      value: { versions: [{ label: 'latest', isDefault: true, deprecated: false }] },
    });
  });
});
