import { beforeAll, expect, it } from 'vitest';
import type { Database } from '@drefyn/db';
import type { GitSyncGate } from '../../src/index.ts';
import {
  BINDING,
  pools,
  recordingLogger,
  seed,
  sha,
  storeOver,
  value,
} from '../support/fixture.ts';
import { describeWithStack } from '../support/presence.ts';

const open = pools();
let db: Database;

beforeAll(async () => {
  db = await open();
});

describeWithStack('bindings and the file map', () => {
  it('creates, reads and pauses one binding per project', async () => {
    const seeded = await seed();
    const logger = recordingLogger();
    const store = storeOver(db, { logger });
    expect(value(await store.getBinding(seeded.tenant))).toBeNull();
    const created = value(await store.createBinding(seeded.tenant, BINDING));
    expect(created).toMatchObject({
      tenant: seeded.tenant,
      installationId: 41,
      repository: { owner: 'acme', name: 'docs', id: 7001 },
      branch: 'main',
      folder: 'docs',
      lastSyncedCommit: null,
      state: 'active',
      stateCode: null,
    });
    expect(value(await store.getBinding(seeded.tenant))).toEqual(created);
    expect(await store.createBinding(seeded.tenant, { ...BINDING, folder: 'other' })).toEqual({
      ok: false,
      error: 'git_sync.binding_exists',
    });
    const paused = value(await store.pauseBinding(seeded.tenant, created.id, 'git.too_large'));
    expect(paused).toMatchObject({ state: 'paused', stateCode: 'git.too_large' });
    expect(logger.lines.map((line) => line.event)).toEqual([
      'git_sync.binding_created',
      'git_sync.binding_paused',
    ]);
  });

  it('binds the repository root', async () => {
    const seeded = await seed();
    const created = value(
      await storeOver(db).createBinding(seeded.tenant, { ...BINDING, folder: '' }),
    );
    expect(created.folder).toBe('');
  });

  it('refuses unsafe folders and malformed input with stable codes', async () => {
    const seeded = await seed();
    const store = storeOver(db);
    expect(await store.createBinding(seeded.tenant, { ...BINDING, folder: '../etc' })).toEqual({
      ok: false,
      error: 'git_sync.folder_unsafe',
    });
    expect(await store.createBinding(seeded.tenant, { ...BINDING, branch: 'a..b' })).toEqual({
      ok: false,
      error: 'git_sync.input_invalid',
    });
    expect(await store.createBinding(seeded.tenant, 'nope')).toEqual({
      ok: false,
      error: 'git_sync.input_invalid',
    });
    expect(value(await store.getBinding(seeded.tenant))).toBeNull();
  });

  it('refuses to pause an unknown binding or with a code that is not one', async () => {
    const seeded = await seed();
    const store = storeOver(db);
    const created = value(await store.createBinding(seeded.tenant, BINDING));
    expect(await store.pauseBinding(seeded.tenant, created.id, 'Not a code')).toEqual({
      ok: false,
      error: 'git_sync.input_invalid',
    });
    expect(
      await store.pauseBinding(seeded.tenant, '01900000-0000-7000-8000-000000000000', 'git.x'),
    ).toEqual({ ok: false, error: 'git_sync.binding_not_found' });
  });

  it('writes and rewrites the file map in path order', async () => {
    const seeded = await seed({ nodes: 2 });
    const store = storeOver(db);
    const binding = value(await store.createBinding(seeded.tenant, BINDING));
    const [a, b] = seeded.nodes;
    if (a === undefined || b === undefined) throw new Error('seed made too few nodes');
    const entries = [
      { path: 'docs/z.mdx', nodeId: a.node, blobSha: sha(1), syncedVersionId: a.version },
      { path: 'docs/guide/a.md', nodeId: b.node, blobSha: sha(2), syncedVersionId: b.version },
    ];
    expect(value(await store.upsertFiles(seeded.tenant, binding.id, entries))).toEqual({
      written: 2,
    });
    const moved = { ...entries[0], blobSha: sha(3) };
    value(await store.upsertFiles(seeded.tenant, binding.id, [moved]));
    expect(value(await store.listFiles(seeded.tenant, binding.id))).toEqual([
      entries[1],
      { ...entries[0], blobSha: sha(3) },
    ]);
    expect(value(await store.upsertFiles(seeded.tenant, binding.id, []))).toEqual({ written: 0 });
  });

  it('refuses a path outside the folder, a bad entry and an unknown binding', async () => {
    const seeded = await seed({ nodes: 1 });
    const other = await seed();
    const store = storeOver(db);
    const binding = value(await store.createBinding(seeded.tenant, BINDING));
    const [a] = seeded.nodes;
    if (a === undefined) throw new Error('seed made too few nodes');
    const entry = {
      path: 'docs/a.mdx',
      nodeId: a.node,
      blobSha: sha(1),
      syncedVersionId: a.version,
    };
    for (const path of ['other/a.mdx', 'docs/../a.mdx', 'docs', '/docs/a.mdx']) {
      expect(await store.upsertFiles(seeded.tenant, binding.id, [{ ...entry, path }])).toEqual({
        ok: false,
        error: 'git_sync.path_outside_folder',
      });
    }
    expect(
      await store.upsertFiles(seeded.tenant, binding.id, [{ ...entry, blobSha: 'xyz' }]),
    ).toEqual({ ok: false, error: 'git_sync.input_invalid' });
    expect(await store.upsertFiles(other.tenant, binding.id, [entry])).toEqual({
      ok: false,
      error: 'git_sync.binding_not_found',
    });
    expect(await store.listFiles(other.tenant, binding.id)).toEqual({
      ok: false,
      error: 'git_sync.binding_not_found',
    });
    expect(await store.listFiles(seeded.tenant, 'nope')).toEqual({
      ok: false,
      error: 'git_sync.input_invalid',
    });
    expect(await store.upsertFiles(seeded.tenant, 'nope', [])).toEqual({
      ok: false,
      error: 'git_sync.input_invalid',
    });
  });

  it('holds the file map to its cap', async () => {
    const seeded = await seed({ nodes: 3 });
    const capped = storeOver(db, { maxFiles: 2 });
    const binding = value(await capped.createBinding(seeded.tenant, BINDING));
    const entries = seeded.nodes.map(({ node, version }, i) => ({
      path: `docs/${String(i)}.mdx`,
      nodeId: node,
      blobSha: sha(i + 1),
      syncedVersionId: version,
    }));
    expect(await capped.upsertFiles(seeded.tenant, binding.id, entries)).toEqual({
      ok: false,
      error: 'git_sync.too_many_files',
    });
    // Written under a wider cap, then read under the narrow one: refused, never cut short.
    value(await storeOver(db).upsertFiles(seeded.tenant, binding.id, entries));
    expect(await capped.listFiles(seeded.tenant, binding.id)).toEqual({
      ok: false,
      error: 'git_sync.too_many_files',
    });
  });

  it('does nothing at all when the gate refuses', async () => {
    const seeded = await seed();
    const closed: GitSyncGate = { check: () => Promise.resolve('git_sync.disabled') };
    const store = storeOver(db, { gate: closed });
    const refused = { ok: false, error: 'git_sync.disabled' };
    expect(await store.createBinding(seeded.tenant, BINDING)).toEqual(refused);
    expect(await store.getBinding(seeded.tenant)).toEqual(refused);
    const id = '01900000-0000-7000-8000-000000000000';
    expect(await store.pauseBinding(seeded.tenant, id, 'git.x')).toEqual(refused);
    expect(await store.listFiles(seeded.tenant, id)).toEqual(refused);
    expect(await store.upsertFiles(seeded.tenant, id, [])).toEqual(refused);
    expect(
      await store.enqueueDelivery(seeded.tenant, { bindingId: id, deliveryId: 'd', headSha: null }),
    ).toEqual(refused);
    expect(await store.claimDelivery(seeded.tenant, id, () => Promise.resolve('done'))).toEqual(
      refused,
    );
    expect(value(await storeOver(db).getBinding(seeded.tenant))).toBeNull();
  });
});
