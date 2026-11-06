import { closeDatabase, type Database } from '@drefyn/db';
import type { FieldId } from '@drefyn/schema';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BACKFILL_BATCH,
  BACKFILL_PAUSE_MS,
  DEFAULT_ENGINE_CONFIG,
  runFilterBackfill,
  type NodeId,
} from '../src/index.ts';
import { admin, openDatabase, type Built, type Seeded } from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';
import {
  addItem,
  dateField,
  declare,
  fieldId,
  itemEngine,
  listField,
  newItem,
  numberField,
  saveItem,
  seedItems,
  textField,
} from './support/typed-items.ts';

let db: Database;
let built: Built;

beforeAll(async () => {
  db = await openDatabase();
  built = itemEngine(db);
});

afterAll(async () => {
  await closeDatabase(db);
});

const noWait = () => Promise.resolve();

const step = async (seeded: Seeded) => {
  const done = await built.engine.backfillFilters(seeded.tenant);
  if (!done.ok) throw new Error(done.error.code);
  return done.value;
};

const stateOf = async (seeded: Seeded, field: FieldId) =>
  admin(
    `select filter_slots -> '${field}' ->> 'state' from app.content_types where id = '${seeded.typeId}';`,
  );

describeWithStack('filter backfill', () => {
  const NAME = fieldId();
  const NOTE = fieldId();
  const NEW = textField(NOTE, 'note', { filterable: true });
  const BASE = [textField(NAME, 'name', { filterable: true })];
  const PLAIN = [...BASE, textField(NOTE, 'note')];

  const stocked = async (count: number) => {
    const seeded = await seedItems();
    await declare(built, seeded, PLAIN);
    const nodes: NodeId[] = [];
    for (let at = 0; at < count; at += 1) {
      nodes.push(await addItem(built, seeded, { [NOTE]: `value ${String(at)}` }));
    }
    return { seeded, nodes };
  };

  it('fills the slot, then the field moves to the slot route', async () => {
    const { seeded, nodes } = await stocked(3);
    const declared = await declare(built, seeded, [BASE[0] as never, NEW], 2);
    expect(declared.backfills).toBe(1);
    expect(await stateOf(seeded, NOTE)).toBe('backfilling');

    const during = await built.engine.queryNodes(seeded.tenant, {
      typeId: seeded.typeId,
      filter: { field: NOTE, op: 'eq', value: 'value 1' },
    });
    expect(during.ok && during.value.backfilling).toEqual([NOTE]);
    expect(during.ok && during.value.items.map((item) => item.nodeId)).toEqual([nodes[1]]);

    const waits: number[] = [];
    await runFilterBackfill(built.engine, seeded.tenant, (ms) => {
      waits.push(ms);
      return Promise.resolve();
    });
    expect(await stateOf(seeded, NOTE)).toBe('ready');
    expect(waits.every((ms) => ms === BACKFILL_PAUSE_MS)).toBe(true);

    const after = await built.engine.queryNodes(seeded.tenant, {
      typeId: seeded.typeId,
      filter: { field: NOTE, op: 'eq', value: 'value 1' },
    });
    expect(after.ok && after.value.backfilling).toEqual([]);
    expect(after.ok && after.value.items.map((item) => item.nodeId)).toEqual([nodes[1]]);
    expect(
      await admin(`select t2 from app.node_filter_rows where node_id = '${String(nodes[1])}';`),
    ).toBe('value 1');
  });

  it('refuses a backfilling field over the scan limit, naming it', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, PLAIN);
    await addItem(built, seeded, { [NOTE]: 'a' });
    await addItem(built, seeded, { [NOTE]: 'b' });
    await declare(built, seeded, [BASE[0] as never, NEW], 2);
    const tight = itemEngine(db, {
      config: { ...DEFAULT_ENGINE_CONFIG, undeclaredScanMaxItems: 1 },
    });
    const page = await tight.engine.queryNodes(seeded.tenant, {
      typeId: seeded.typeId,
      filter: { field: NOTE, op: 'exists' },
    });
    expect(page).toMatchObject({
      ok: false,
      error: { code: 'engine.filter_backfilling', issues: [{ fieldId: NOTE }] },
    });
  });

  it('never overwrites a racing save with a stale value', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, PLAIN);
    const node = await newItem(built, seeded);
    const first = await saveItem(built, seeded, node, null, { [NOTE]: 'old' });
    await declare(built, seeded, [BASE[0] as never, NEW], 2);

    // The save holds the node's lock through commit while the batch runs.
    const racing = saveItem(built, seeded, node, first.versionId, { [NOTE]: 'new' });
    const batch = runFilterBackfill(built.engine, seeded.tenant, noWait);
    await Promise.all([racing, batch]);
    expect(await admin(`select t2 from app.node_filter_rows where node_id = '${node}';`)).toBe(
      'new',
    );
  });

  it('a save made while a slot fills writes that slot', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, PLAIN);
    const node = await newItem(built, seeded);
    const first = await saveItem(built, seeded, node, null, { [NOTE]: 'old' });
    await declare(built, seeded, [BASE[0] as never, NEW], 2);
    await saveItem(built, seeded, node, first.versionId, { [NOTE]: 'during' });
    expect(await admin(`select t2 from app.node_filter_rows where node_id = '${node}';`)).toBe(
      'during',
    );
  });

  it('works in batches and resumes after a stop', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, PLAIN);
    const count = BACKFILL_BATCH + 10;
    await admin(`
set session_replication_role = replica;
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle, head_fields)
  select '${seeded.organization}', '${seeded.project}', 'studio_item', '${seeded.typeId}', 'a', 'draft',
         jsonb_build_object('${NOTE}', 'v' || g)
  from generate_series(1, ${String(count)}) g;
insert into app.node_filter_rows (organization_id, project_id, type_id, node_id)
  select organization_id, project_id, type_id, id from app.nodes where type_id = '${seeded.typeId}';`);
    await declare(built, seeded, [BASE[0] as never, NEW], 2);

    expect(await step(seeded)).toBe('running');
    const filled = () =>
      admin(`select count(t2) from app.node_filter_rows where type_id = '${seeded.typeId}';`);
    expect(await filled()).toBe(String(BACKFILL_BATCH));
    expect(await stateOf(seeded, NOTE)).toBe('backfilling');

    // A new engine is a restarted job: only the table remembers.
    const restarted = itemEngine(db);
    await runFilterBackfill(restarted.engine, seeded.tenant, noWait);
    expect(await filled()).toBe(String(count));
    expect(await stateOf(seeded, NOTE)).toBe('ready');
  });

  it('runs one backfill per organization, across projects', async () => {
    const one = await seedItems();
    const two = await seedItems({ organization: one.organization });
    const third = await seedItems();
    for (const seeded of [one, two, third]) {
      await declare(built, seeded, PLAIN);
      await admin(`
set session_replication_role = replica;
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle)
  select '${seeded.organization}', '${seeded.project}', 'studio_item', '${seeded.typeId}', 'a', 'draft'
  from generate_series(1, ${String(BACKFILL_BATCH + 1)});
insert into app.node_filter_rows (organization_id, project_id, type_id, node_id)
  select organization_id, project_id, type_id, id from app.nodes where type_id = '${seeded.typeId}';`);
      await declare(built, seeded, [BASE[0] as never, NEW], 2);
    }
    expect(await step(one)).toBe('running');
    expect(await step(two)).toBe('waiting');
    expect(await step(third)).toBe('running');
    await runFilterBackfill(built.engine, one.tenant, noWait);
    expect(await step(two)).toBe('running');
  });

  it('fills a list slot and keeps exists honest', async () => {
    const seeded = await seedItems();
    const TAGS = fieldId();
    const plain = listField(TAGS, 'tags');
    await declare(built, seeded, [plain]);
    const a = await addItem(built, seeded, { [TAGS]: ['x', 'y'] });
    await addItem(built, seeded, {});
    await declare(built, seeded, [{ ...plain, filterable: true }], 2);
    await runFilterBackfill(built.engine, seeded.tenant, noWait);
    const page = await built.engine.queryNodes(seeded.tenant, {
      typeId: seeded.typeId,
      filter: { field: TAGS, op: 'exists' },
    });
    expect(page.ok && page.value.items.map((item) => item.nodeId)).toEqual([a]);
    expect(await admin(`select l1 from app.node_filter_rows where node_id = '${a}';`)).toBe(
      '{x,y}',
    );
  });

  it('fills an integer slot from integer units', async () => {
    const seeded = await seedItems();
    const COUNT = fieldId();
    const plain = numberField(COUNT, 'count');
    await declare(built, seeded, [plain]);
    const a = await addItem(built, seeded, { [COUNT]: '1.25' });
    await declare(built, seeded, [{ ...plain, filterable: true }], 2);
    await runFilterBackfill(built.engine, seeded.tenant, noWait);
    expect(await admin(`select i1 from app.node_filter_rows where node_id = '${a}';`)).toBe('125');
  });

  it('clears a removed field before its slot can go back in use', async () => {
    const seeded = await seedItems();
    const GONE = fieldId();
    const KEPT = textField(NAME, 'name', { filterable: true });
    const gone = textField(GONE, 'gone', { filterable: true });
    await declare(built, seeded, [KEPT, gone]);
    const a = await addItem(built, seeded, { [GONE]: 'x' });
    await declare(built, seeded, [KEPT, gone], 2, { deprecated: [GONE] });
    await declare(built, seeded, [KEPT], 3, { retired: [GONE], confirmedRemovals: [GONE] });
    expect(await stateOf(seeded, GONE)).toBe('clearing');
    await runFilterBackfill(built.engine, seeded.tenant, noWait);
    expect(await admin(`select t2 from app.node_filter_rows where node_id = '${a}';`)).toBe('');
    expect(await stateOf(seeded, GONE)).toBe('');
  });

  it('keeps slots stable across schema versions', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, PLAIN);
    const column = () =>
      admin(
        `select filter_slots -> '${NAME}' ->> 'column' from app.content_types where id = '${seeded.typeId}';`,
      );
    const before = await column();
    await declare(built, seeded, [NEW, BASE[0] as never], 2);
    expect(await column()).toBe(before);
  });

  describe('a year 0000 value stored before it was refused', () => {
    const SEEN = fieldId();
    const SEEN_PLAIN = dateField(SEEN, 'seen');
    const SEEN_DECLARED = dateField(SEEN, 'seen', { filterable: true });

    const poisoned = async () => {
      const seeded = await seedItems();
      await declare(built, seeded, [...BASE, SEEN_PLAIN]);
      const poison = await addItem(built, seeded, { [SEEN]: '2026-01-01T00:00:00Z' });
      const healthy = await addItem(built, seeded, { [SEEN]: '2026-02-01T00:00:00Z' });
      await admin(`
update app.nodes set head_fields = jsonb_set(head_fields, '{${SEEN}}', '"0000-06-01T00:00:00.000Z"')
  where id = '${poison}';`);
      return { seeded, poison, healthy };
    };

    it('cannot stop a fill, which leaves that item empty', async () => {
      const { seeded, healthy } = await poisoned();
      await declare(built, seeded, [...BASE, SEEN_DECLARED], 2);
      const done = await runFilterBackfill(built.engine, seeded.tenant, noWait);
      expect(done).toEqual({ ok: true, value: 'idle' });
      expect(await stateOf(seeded, SEEN)).toBe('ready');
      const page = await built.engine.queryNodes(seeded.tenant, {
        typeId: seeded.typeId,
        filter: { field: SEEN, op: 'exists' },
      });
      expect(page.ok && page.value.items.map((item) => item.nodeId)).toEqual([healthy]);
    });

    it('cannot hold up the next job in the project', async () => {
      const { seeded } = await poisoned();
      await declare(built, seeded, [...PLAIN, SEEN_DECLARED], 2);
      await declare(built, seeded, [BASE[0] as never, NEW, SEEN_DECLARED], 3);
      await runFilterBackfill(built.engine, seeded.tenant, noWait);
      expect(await stateOf(seeded, SEEN)).toBe('ready');
      expect(await stateOf(seeded, NOTE)).toBe('ready');
    });
  });

  it('stops with no work when nothing is queued', async () => {
    const seeded = await seedItems();
    expect(await step(seeded)).toBe('idle');
  });

  it('does not run with writes off', async () => {
    const seeded = await seedItems();
    const off = itemEngine(db, { flags: { evaluate: () => Promise.resolve({ value: false }) } });
    const done = await off.engine.backfillFilters(seeded.tenant);
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.forbidden' } });
  });
});
