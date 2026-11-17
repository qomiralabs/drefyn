import { closeDatabase, type Database, type PublishedDatabase } from '@drefyn/db';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  bodies,
  openApp,
  openReader,
  retrievalOver,
  seedPages,
  seedTenants,
  type Seeded,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';
import { capturedLogger } from '../support/scripted.ts';

describeWithStack('the search engine threshold', () => {
  let app: Database;
  let reader: PublishedDatabase;
  let seeded: Seeded;

  beforeAll(async () => {
    app = await openApp();
    reader = await openReader();
    [seeded] = (await seedTenants([1])) as [Seeded];
    await seedPages(
      app,
      seeded,
      bodies('big', ['thresholdcanary one', 'thresholdcanary two', 'thresholdcanary three']),
    );
  });

  afterAll(async () => {
    await closeDatabase(reader);
    await closeDatabase(app);
  });

  const run = async (threshold: number) => {
    const log = capturedLogger();
    const retrieval = retrievalOver(reader, {
      config: { searchEngineMinChunks: threshold },
      logger: log.logger,
    });
    const result = await retrieval.retrieve(seeded.tenant, { query: 'thresholdcanary' });
    return { result, log };
  };

  it('a project above it still answers on Postgres and says so with ids and a count only', async () => {
    const { result, log } = await run(2);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.hits).toHaveLength(3);
    const over = log.lines.filter((l) => l.event === 'retrieval.over_engine_threshold');
    expect(over).toEqual([
      {
        level: 'info',
        event: 'retrieval.over_engine_threshold',
        fields: {
          organizationId: seeded.tenant.organizationId,
          projectId: seeded.tenant.projectId,
          chunkCount: 3,
          threshold: 2,
        },
      },
    ]);
    expect(JSON.stringify(log.lines)).not.toMatch(/thresholdcanary|two|three/);
  });

  it('at the threshold, under it, or with 0 there is no event', async () => {
    for (const threshold of [3, 4, 0]) {
      const { result, log } = await run(threshold);
      expect(result.ok).toBe(true);
      expect(log.lines.filter((l) => l.event === 'retrieval.over_engine_threshold')).toEqual([]);
    }
  });
});
