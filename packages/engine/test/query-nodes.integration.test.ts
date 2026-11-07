import { randomUUID } from 'node:crypto';
import { closeDatabase, withTenant, type Database } from '@drefyn/db';
import { type FieldDef, type FieldId, type FilterNode } from '@drefyn/schema';
import fc from 'fast-check';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createEngine,
  databaseStore,
  DEFAULT_ENGINE_CONFIG,
  type EngineStore,
  type NodeId,
} from '../src/index.ts';
import { createPoolGate, gateLimits } from '../src/pool-gate.ts';
import {
  admin,
  ACTOR,
  key,
  openDatabase,
  parseClient,
  PARSE_POLICY,
  tree,
  type Built,
  type Seeded,
} from './support/fixture.ts';
import { describeWithStack } from './support/presence.ts';
import {
  addItem,
  booleanField,
  dateField,
  declare,
  fieldId,
  itemEngine,
  listField,
  newItem,
  numberField,
  saveItem,
  schemaOf,
  seedItems,
  textField,
} from './support/typed-items.ts';

let db: Database;
let built: Built;

// Named statements get generic plans, and a filter matching nothing took 341,004 buffers that way
// against 18. Also the last word on whether a value can reach the text.
function statementProblems(sent: readonly unknown[], marker: string): readonly string[] {
  return sent.flatMap((statement) => {
    const { name, text } = (typeof statement === 'string' ? { text: statement } : statement) as {
      readonly name?: string;
      readonly text: string;
    };
    const problems: string[] = [];
    if (name !== undefined) problems.push(`named: ${name}`);
    if (text.includes(marker)) problems.push(`in text: ${text}`);
    return problems;
  });
}

const list = async (
  seeded: Seeded,
  query: Omit<Parameters<Built['engine']['queryNodes']>[1], 'typeId'>,
) => {
  const page = await built.engine.queryNodes(seeded.tenant, { typeId: seeded.typeId, ...query });
  if (!page.ok) throw new Error(`queryNodes refused: ${JSON.stringify(page.error)}`);
  return page.value;
};

const ids = async (seeded: Seeded, filter: FilterNode) =>
  (await list(seeded, { filter, limit: 100 })).items.map((item) => item.nodeId as string).sort();

const refusal = async (seeded: Seeded, query: Record<string, unknown>) => {
  const page = await built.engine.queryNodes(seeded.tenant, { typeId: seeded.typeId, ...query });
  if (page.ok) throw new Error('expected a refusal');
  return page.error;
};

// Bulk rows, written past the engine, for sizes that would take minutes one save at a time. The
// rows are valid as written, and foreign key checks on a table with no statistics take seconds,
// which holds up every test file that needs a lock on these shared tables.
const bulkItems = (seeded: Seeded, count: number) =>
  admin(`
set session_replication_role = replica;
insert into app.nodes (organization_id, project_id, family, type_id, order_key, lifecycle)
  select '${seeded.organization}', '${seeded.project}', 'studio_item', '${seeded.typeId}', 'a', 'draft'
  from generate_series(1, ${String(count)});
insert into app.node_filter_rows (organization_id, project_id, type_id, node_id)
  select organization_id, project_id, type_id, id from app.nodes
  where type_id = '${seeded.typeId}'
  on conflict do nothing;`);

beforeAll(async () => {
  db = await openDatabase();
  built = itemEngine(db);
});

afterAll(async () => {
  await closeDatabase(db);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describeWithStack('queryNodes', () => {
  const NAME = fieldId();
  const PRICE = fieldId();
  const LIVE = fieldId();
  const AT = fieldId();
  const TAGS = fieldId();
  const NOTE = fieldId();
  const FIELDS: readonly FieldDef[] = [
    textField(NAME, 'name', { filterable: true, sortable: true }),
    numberField(PRICE, 'price', { filterable: true, sortable: true }),
    booleanField(LIVE, 'live', { filterable: true }),
    dateField(AT, 'at', { filterable: true, sortable: true }),
    listField(TAGS, 'tags', { filterable: true }),
    textField(NOTE, 'note'),
  ];

  const stocked = async () => {
    const seeded = await seedItems();
    await declare(built, seeded, FIELDS);
    return seeded;
  };

  it('filters on every operator through the slots', async () => {
    const seeded = await stocked();
    const a = await addItem(built, seeded, {
      [NAME]: 'Apple pie',
      [PRICE]: '1.50',
      [LIVE]: true,
      [AT]: '2026-01-01T00:00:00Z',
      [TAGS]: ['red', 'sweet'],
    });
    const b = await addItem(built, seeded, {
      [NAME]: 'Banana',
      [PRICE]: '2.00',
      [LIVE]: false,
      [AT]: '2026-02-01T00:00:00Z',
      [TAGS]: ['yellow'],
    });
    const empty = await addItem(built, seeded, {});
    const sorted = (...values: readonly string[]) => [...values].sort();

    expect(await ids(seeded, { field: NAME, op: 'eq', value: 'Banana' })).toEqual([b]);
    expect(await ids(seeded, { field: NAME, op: 'neq', value: 'Banana' })).toEqual(
      sorted(a, empty),
    );
    expect(await ids(seeded, { field: NAME, op: 'in', value: ['Banana', 'x'] })).toEqual([b]);
    expect(await ids(seeded, { field: NAME, op: 'contains', value: 'PIE' })).toEqual([a]);
    expect(await ids(seeded, { field: PRICE, op: 'gt', value: '1.50' })).toEqual([b]);
    expect(await ids(seeded, { field: PRICE, op: 'gte', value: '1.50' })).toEqual(sorted(a, b));
    expect(await ids(seeded, { field: PRICE, op: 'lt', value: '2' })).toEqual([a]);
    expect(await ids(seeded, { field: PRICE, op: 'lte', value: '2.00' })).toEqual(sorted(a, b));
    expect(await ids(seeded, { field: PRICE, op: 'in', value: ['1.5'] })).toEqual([a]);
    expect(await ids(seeded, { field: LIVE, op: 'eq', value: true })).toEqual([a]);
    expect(await ids(seeded, { field: LIVE, op: 'neq', value: true })).toEqual(sorted(b, empty));
    expect(await ids(seeded, { field: AT, op: 'gt', value: '2026-01-01T00:00:00+00:00' })).toEqual([
      b,
    ]);
    expect(await ids(seeded, { field: TAGS, op: 'eq', value: 'red' })).toEqual([a]);
    expect(await ids(seeded, { field: TAGS, op: 'neq', value: 'red' })).toEqual(sorted(b, empty));
    expect(await ids(seeded, { field: TAGS, op: 'in', value: ['yellow', 'red'] })).toEqual(
      sorted(a, b),
    );
    expect(await ids(seeded, { field: TAGS, op: 'exists' })).toEqual(sorted(a, b));
    expect(await ids(seeded, { not: { field: NAME, op: 'exists' } })).toEqual([empty]);
  });

  it('a percent or underscore in contains is only a character', async () => {
    const seeded = await stocked();
    const a = await addItem(built, seeded, { [NAME]: '100% sure' });
    await addItem(built, seeded, { [NAME]: '100 percent' });
    expect(await ids(seeded, { field: NAME, op: 'contains', value: '0%' })).toEqual([a]);
    expect(await ids(seeded, { field: NAME, op: 'contains', value: '_' })).toEqual([]);
  });

  it('treats hostile text as a value', async () => {
    const seeded = await stocked();
    const value = `'; drop table app.nodes; --`;
    const a = await addItem(built, seeded, { [NAME]: value });
    await addItem(built, seeded, { [NAME]: 'plain' });
    expect(await ids(seeded, { field: NAME, op: 'eq', value })).toEqual([a]);
  });

  it('agrees with a plain evaluation on both routes', async () => {
    const seeded = await seedItems();
    const [declaredName, declaredCount, plainName, plainCount] = [
      fieldId(),
      fieldId(),
      fieldId(),
      fieldId(),
    ] as [FieldId, FieldId, FieldId, FieldId];
    await declare(built, seeded, [
      textField(declaredName, 'a', { filterable: true }),
      numberField(declaredCount, 'b', { filterable: true, scale: 0 }),
      textField(plainName, 'c'),
      numberField(plainCount, 'd', { scale: 0 }),
    ]);
    const rows: { id: string; name: string | undefined; count: number | undefined }[] = [];
    const names = ['a', 'b', 'c', undefined];
    const counts = [1, 2, 3, undefined];
    for (const name of names) {
      for (const count of counts) {
        const id = await addItem(built, seeded, {
          ...(name === undefined ? {} : { [declaredName]: name, [plainName]: name }),
          ...(count === undefined
            ? {}
            : { [declaredCount]: String(count), [plainCount]: String(count) }),
        });
        rows.push({ id, name, count });
      }
    }

    type Tree =
      | { and: Tree[] }
      | { or: Tree[] }
      | { not: Tree }
      | { kind: 'name' | 'count'; op: string; value: string | undefined };
    const leaf: fc.Arbitrary<Tree> = fc.oneof(
      fc.record({
        kind: fc.constant<'name'>('name'),
        op: fc.constantFrom('eq', 'neq', 'gt', 'lte'),
        value: fc.constantFrom('a', 'b', 'z'),
      }),
      fc.record({
        kind: fc.constant<'count'>('count'),
        op: fc.constantFrom('eq', 'neq', 'gte', 'lt'),
        value: fc.constantFrom('1', '2', '9'),
      }),
      fc.record({
        kind: fc.constantFrom<'name' | 'count'>('name', 'count'),
        op: fc.constant('exists'),
        value: fc.constant(undefined),
      }),
    );
    const trees = fc.letrec<{ node: Tree }>((self) => ({
      node: fc.oneof(
        { maxDepth: 3, depthIdentifier: 'tree' },
        leaf,
        fc.record({ and: fc.array(self('node'), { minLength: 1, maxLength: 3 }) }),
        fc.record({ or: fc.array(self('node'), { minLength: 1, maxLength: 3 }) }),
        fc.record({ not: self('node') }),
      ),
    })).node;

    const toFilter = (node: Tree, nameId: FieldId, countId: FieldId): FilterNode => {
      if ('and' in node) return { and: node.and.map((n) => toFilter(n, nameId, countId)) };
      if ('or' in node) return { or: node.or.map((n) => toFilter(n, nameId, countId)) };
      if ('not' in node) return { not: toFilter(node.not, nameId, countId) };
      const field = node.kind === 'name' ? nameId : countId;
      return node.value === undefined
        ? { field, op: 'exists' }
        : ({ field, op: node.op, value: node.value } as FilterNode);
    };

    const holds = (node: Tree, row: (typeof rows)[number]): boolean => {
      if ('and' in node) return node.and.every((n) => holds(n, row));
      if ('or' in node) return node.or.some((n) => holds(n, row));
      if ('not' in node) return !holds(node.not, row);
      const have = node.kind === 'name' ? row.name : row.count;
      if (node.op === 'exists') return have !== undefined;
      if (node.op === 'neq') return String(have) !== node.value;
      if (have === undefined) return false;
      const want = node.kind === 'name' ? (node.value ?? '') : Number(node.value);
      if (node.op === 'eq') return have === want;
      if (node.op === 'gt') return have > want;
      if (node.op === 'gte') return have >= want;
      if (node.op === 'lt') return have < want;
      return have <= want;
    };

    await fc.assert(
      fc.asyncProperty(trees, async (node) => {
        const expected = rows
          .filter((row) => holds(node, row))
          .map((row) => row.id)
          .sort();
        expect(await ids(seeded, toFilter(node, declaredName, declaredCount))).toEqual(expected);
        expect(await ids(seeded, toFilter(node, plainName, plainCount))).toEqual(expected);
      }),
      { numRuns: 60 },
    );
  });

  it('walks every item once across pages, nulls last, both directions', async () => {
    const seeded = await stocked();
    const made: string[] = [];
    for (const price of ['3', '1', '2', '2']) {
      made.push(await addItem(built, seeded, { [PRICE]: price }));
    }
    const blank = await addItem(built, seeded, {});
    for (const direction of ['asc', 'desc'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let turn = 0; turn < 6; turn += 1) {
        const page = await list(seeded, {
          sort: { field: PRICE, direction },
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.items.map((item) => item.nodeId));
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect([...seen].sort()).toEqual([...made, blank].sort());
      expect(seen.at(-1)).toBe(blank);
      expect(seen[0]).toBe(direction === 'asc' ? made[1] : made[0]);
    }
  });

  it('lists newest first with no sort, and an item with no save appears', async () => {
    const seeded = await stocked();
    const a = await newItem(built, seeded);
    const b = await newItem(built, seeded);
    const page = await list(seeded, {});
    expect(page.items.map((item) => item.nodeId)).toEqual([b, a]);
    expect(page.items[0]).toMatchObject({
      family: 'studio_item',
      lifecycle: 'draft',
      versionId: null,
    });
  });

  it('refuses a cursor from another order, and a forged one', async () => {
    const seeded = await stocked();
    await addItem(built, seeded, { [PRICE]: '1' });
    await addItem(built, seeded, { [PRICE]: '2' });
    const { nextCursor } = await list(seeded, { sort: { field: PRICE }, limit: 1 });
    const code = 'engine.cursor_invalid';
    const other = await refusal(seeded, { sort: { field: NAME }, cursor: nextCursor });
    expect(other.issues[0]?.code).toBe(code);
    const tail = await refusal(seeded, { cursor: nextCursor });
    expect(tail.issues[0]?.code).toBe(code);
    const garbage = await refusal(seeded, { cursor: 'not a cursor' });
    expect(garbage.issues[0]?.code).toBe(code);
    const forged = (held: object) => Buffer.from(JSON.stringify(held)).toString('base64url');
    const bad = await refusal(seeded, {
      sort: { field: PRICE },
      cursor: forged({ s: PRICE, d: 'asc', v: `1'; drop`, n: randomUUID() }),
    });
    expect(bad.issues[0]?.code).toBe(code);
    const unknown = await refusal(seeded, {
      sort: { field: PRICE },
      cursor: forged({ s: PRICE, d: 'asc', n: randomUUID() }),
    });
    expect(unknown.issues[0]?.code).toBe(code);
    const plain = await refusal(seeded, {
      cursor: forged({ s: null, d: 'desc', n: randomUUID() }),
    });
    expect(plain.issues[0]?.code).toBe(code);
  });

  // Each of these reached Postgres when the sort value travelled in the cursor.
  it.each([
    ['a far offset', '2026-01-01T00:00:00+23:00'],
    ['year 0000', '0000-01-01T00:00:00Z'],
  ])('refuses a cursor carrying %s, with no server error', async (_name, v) => {
    const seeded = await stocked();
    const made = await addItem(built, seeded, { [AT]: '2026-01-01T00:00:00Z' });
    const cursor = Buffer.from(JSON.stringify({ s: AT, d: 'asc', v, n: made })).toString(
      'base64url',
    );
    const error = await refusal(seeded, { sort: { field: AT }, cursor });
    expect(error.issues[0]?.code).toBe('engine.cursor_invalid');
  });

  it('holds no field value in a cursor, and still walks a tied sort', async () => {
    const seeded = await stocked();
    const value = 'a value that must stay out of logs';
    const made = [
      await addItem(built, seeded, { [NAME]: value }),
      await addItem(built, seeded, { [NAME]: value }),
      await addItem(built, seeded, { [NAME]: value }),
    ];
    const first = await list(seeded, { sort: { field: NAME }, limit: 1 });
    const decoded = Buffer.from(first.nextCursor ?? '', 'base64url').toString();
    expect(decoded).not.toContain(value);
    const second = await list(seeded, {
      sort: { field: NAME },
      limit: 5,
      cursor: first.nextCursor ?? '',
    });
    const seen = [...first.items, ...second.items].map((item) => item.nodeId as string);
    expect(seen.sort()).toEqual([...made].sort());
  });

  it('walks on past a node deleted between pages, on both routes', async () => {
    const seeded = await stocked();
    const made = [
      await addItem(built, seeded, { [PRICE]: '1', [NOTE]: 'x' }),
      await addItem(built, seeded, { [PRICE]: '2', [NOTE]: 'x' }),
      await addItem(built, seeded, { [PRICE]: '3', [NOTE]: 'x' }),
    ];
    const queries = [{}, { filter: { field: NOTE, op: 'eq', value: 'x' } }] as const;
    const sort = { field: PRICE };
    const pages = await Promise.all(
      queries.map((query) => list(seeded, { ...query, sort, limit: 1 })),
    );
    await admin(`update app.nodes set deleted_at = now() where id = '${made[0] ?? ''}'`);
    for (const [index, query] of queries.entries()) {
      const next = await list(seeded, {
        ...query,
        sort,
        limit: 5,
        cursor: pages[index]?.nextCursor ?? '',
      });
      expect(next.items.map((item) => item.nodeId)).toEqual([made[1], made[2]]);
    }
  });

  it('refuses a sort that is not declared', async () => {
    const seeded = await stocked();
    const error = await refusal(seeded, { sort: { field: NOTE } });
    expect(error.code).toBe('engine.validation_failed');
    expect(error.issues[0]).toMatchObject({ code: 'engine.sort_not_declared', fieldId: NOTE });
  });

  it('refuses a broken filter with a code and no value', async () => {
    const seeded = await stocked();
    const secret = 'a-secret-value';
    const error = await refusal(seeded, { filter: { field: PRICE, op: 'eq', value: secret } });
    expect(error.code).toBe('engine.validation_failed');
    expect(error.issues[0]?.code).toBe('filter.value_invalid');
    expect(JSON.stringify(error)).not.toContain(secret);
    const raw = await refusal(seeded, { filter: `name = '${secret}'` });
    expect(raw.issues[0]?.code).toBe('filter.malformed');
  });

  it('refuses an instant past what a date can hold, without a server error', async () => {
    const seeded = await stocked();
    const value = '9999-12-31T23:59:59-01:00';
    const error = await refusal(seeded, { filter: { field: AT, op: 'gt', value } });
    expect(error.issues[0]?.code).toBe('filter.value_invalid');
  });

  it.each([
    ['a plain year 0000', '0000-06-01T00:00:00Z'],
    ['a shift into year 0000', '0001-01-01T00:00:00+02:00'],
  ])('refuses %s in a filter, and in a save, with no server error', async (_name, value) => {
    const seeded = await stocked();
    const error = await refusal(seeded, { filter: { field: AT, op: 'eq', value } });
    expect(error.issues[0]?.code).toBe('filter.value_invalid');
    const node = await newItem(built, seeded);
    const saved = await built.engine.saveDraft({
      tenant: seeded.tenant,
      nodeId: node,
      expectedHeadVersionId: null,
      content: await tree(built.parse, seeded, 'A body.'),
      origin: 'human',
      actor: ACTOR,
      idempotencyKey: key(),
      fields: { [AT]: value },
    });
    expect(saved).toMatchObject({
      ok: false,
      error: { issues: [{ code: 'engine.field_invalid' }] },
    });
  });

  // A lone surrogate survives the driver as text, but JSON keeps it escaped and jsonb refuses that.
  it.each([
    ['a declared field', 'declared'],
    ['an undeclared list, which goes through jsonb', 'undeclared'],
  ])('refuses a lone surrogate on %s, with no server error', async (_name, route) => {
    const seeded = await stocked();
    const other = fieldId();
    await declare(built, seeded, [...FIELDS, listField(other, 'labels')], 2);
    const field = route === 'declared' ? NAME : other;
    for (const filter of [
      { field, op: 'eq', value: '\ud800' },
      { field, op: 'in', value: ['fine', '\udc00'] },
    ]) {
      const error = await refusal(seeded, { filter });
      expect(error.code).toBe('engine.validation_failed');
      expect(error.issues[0]?.code).toBe('filter.value_invalid');
    }
  });

  it('reads a year 0000 value stored before it was refused as missing', async () => {
    const seeded = await stocked();
    const other = fieldId();
    await declare(built, seeded, [...FIELDS, dateField(other, 'seen')], 2);
    const old = await addItem(built, seeded, { [other]: '2026-01-01T00:00:00Z' });
    const fine = await addItem(built, seeded, { [other]: '2026-02-01T00:00:00Z' });
    await admin(`
update app.nodes set head_fields = jsonb_set(head_fields, '{${other}}', '"0000-06-01T00:00:00.000Z"')
  where id = '${old}';`);
    const page = await list(seeded, { filter: { field: other, op: 'exists' } });
    expect(page.items.map((item) => item.nodeId)).toEqual([fine]);
  });

  it('matches a filter past a bound or length rather than failing', async () => {
    const seeded = await seedItems();
    const small = fieldId();
    await declare(built, seeded, [
      numberField(small, 'small', { filterable: true, min: '0', max: '10' }),
    ]);
    const a = await addItem(built, seeded, { [small]: '5' });
    expect(await ids(seeded, { field: small, op: 'gt', value: '-5' })).toEqual([a]);
  });

  it('a type with no definition lists, and refuses every filter field', async () => {
    const seeded = await seedItems();
    const a = await newItem(built, seeded);
    expect((await list(seeded, {})).items.map((item) => item.nodeId)).toEqual([a]);
    const error = await refusal(seeded, { filter: { field: NAME, op: 'exists' } });
    expect(error.issues[0]?.code).toBe('filter.field_unknown');
  });

  describe('undeclared filters', () => {
    it('scans head fields at the limit and refuses one item past it', async () => {
      const seeded = await stocked();
      const a = await addItem(built, seeded, { [NOTE]: 'needle' });
      await bulkItems(seeded, 19_999);
      const filter = { field: NOTE, op: 'eq', value: 'needle' } as const;
      expect(await ids(seeded, filter)).toEqual([a]);

      await bulkItems(seeded, 1);
      const error = await refusal(seeded, { filter });
      expect(error.code).toBe('engine.filter_not_declared');
      expect(error.retryable).toBe(false);
      expect(error.issues[0]).toMatchObject({ fieldId: NOTE });
      expect(error.issues[0]?.message).toContain('Declare this field');

      // Declared fields do not care.
      await expect(
        built.engine.queryNodes(seeded.tenant, {
          typeId: seeded.typeId,
          filter: { field: NAME, op: 'exists' },
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('never touches the slots or content on a scan', async () => {
      const seeded = await stocked();
      const a = await addItem(built, seeded, { [NOTE]: 'needle', [NAME]: 'x' });
      const page = await ids(seeded, {
        and: [
          { field: NOTE, op: 'contains', value: 'EED' },
          { field: NAME, op: 'eq', value: 'x' },
        ],
      });
      expect(page).toEqual([a]);
    });

    it('holds to a lower configured limit', async () => {
      const seeded = await stocked();
      await addItem(built, seeded, { [NOTE]: 'a' });
      await addItem(built, seeded, { [NOTE]: 'b' });
      const tight = itemEngine(db, {
        config: { ...DEFAULT_ENGINE_CONFIG, undeclaredScanMaxItems: 1 },
      });
      const page = await tight.engine.queryNodes(seeded.tenant, {
        typeId: seeded.typeId,
        filter: { field: NOTE, op: 'exists' },
      });
      expect(page).toMatchObject({ ok: false, error: { code: 'engine.filter_not_declared' } });
    });
  });

  describe('tenancy', () => {
    it('never shows another tenant, with the same field ids and values', async () => {
      const home = await stocked();
      const other = await seedItems();
      const sibling = await seedItems({ organization: home.organization });
      await declare(
        built,
        other,
        FIELDS.map((field) => field),
      );
      await declare(
        built,
        sibling,
        FIELDS.map((field) => field),
      );
      const mine = await addItem(built, home, { [NAME]: 'same', [NOTE]: 'same' });
      await addItem(built, other, { [NAME]: 'same', [NOTE]: 'same' });
      await addItem(built, sibling, { [NAME]: 'same', [NOTE]: 'same' });

      expect(await ids(home, { field: NAME, op: 'eq', value: 'same' })).toEqual([mine]);
      expect(await ids(home, { field: NOTE, op: 'eq', value: 'same' })).toEqual([mine]);
      expect((await list(home, {})).items.map((item) => item.nodeId)).toEqual([mine]);
    });

    it('answers not found for another tenant type', async () => {
      const home = await stocked();
      const other = await stocked();
      await addItem(built, other, { [NAME]: 'theirs' });
      const page = await built.engine.queryNodes(home.tenant, { typeId: other.typeId });
      expect(page).toMatchObject({ ok: false, error: { code: 'engine.not_found' } });
    });

    it('a cursor from another tenant shows nothing of theirs', async () => {
      const home = await stocked();
      const other = await stocked();
      await addItem(built, other, {});
      await addItem(built, other, {});
      const theirs = await list(other, { limit: 1 });
      const mine = await addItem(built, home, {});
      const page = await built.engine.queryNodes(home.tenant, {
        typeId: home.typeId,
        cursor: theirs.nextCursor ?? '',
      });
      expect(page).toMatchObject({
        ok: false,
        error: { issues: [{ code: 'engine.cursor_invalid' }] },
      });
      expect((await list(home, {})).items.map((item) => item.nodeId)).toEqual([mine]);
    });

    it('policy alone hides filter rows, even with no filter on the tenant', async () => {
      const home = await stocked();
      const other = await stocked();
      await addItem(built, other, { [NAME]: 'theirs' });
      const seen = await withTenant(db, home.tenant, (tx) =>
        sql<{ rows: number }>`
          select count(*) as rows from app.node_filter_rows
          where type_id = ${other.typeId}::uuid`.execute(tx),
      );
      expect(seen.rows[0]?.rows).toBe(0);
    });

    it('a filter row cannot be written for another tenant', async () => {
      const home = await stocked();
      const other = await stocked();
      const node = await newItem(built, other);
      await expect(
        withTenant(db, home.tenant, (tx) =>
          sql`insert into app.node_filter_rows (organization_id, project_id, type_id, node_id)
              values (${other.organization}::uuid, ${other.project}::uuid,
                      ${other.typeId}::uuid, ${node as string}::uuid)`.execute(tx),
        ),
      ).rejects.toMatchObject({ code: 'DB_RLS_VIOLATION' });
    });
  });

  // Connections are held open until the end, so without the cap the crowd would fill the pool
  // and the second organization would wait out poolWaitMs.
  it('holds one organization to its cap under load, and others get their answer', async () => {
    const crowded = await stocked();
    const quiet = await stocked();
    await addItem(built, crowded, {});
    await addItem(built, quiet, {});
    const CAP = 3;
    const CROWD = 40;
    const inner = databaseStore(db, DEFAULT_ENGINE_CONFIG);
    const config = { ...DEFAULT_ENGINE_CONFIG, queryMaxInFlight: CAP };
    const { promise: open, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: full, resolve: filled } = Promise.withResolvers<undefined>();
    let holding = 0;
    const store: EngineStore = {
      gate: createPoolGate(gateLimits(config, 10)),
      tenant: (tenant, work, options) =>
        inner.tenant(
          tenant,
          async (tx) => {
            if (tenant.organizationId === crowded.tenant.organizationId) {
              holding += 1;
              if (holding === CAP) filled(undefined);
              await open;
            }
            return work(tx);
          },
          options,
        ),
    };
    const held = itemEngine(db, {
      store,
      config,
    });
    const crowd = Array.from({ length: CROWD }, () =>
      held.engine.queryNodes(crowded.tenant, { typeId: crowded.typeId }),
    );
    await full;

    const answer = await held.engine.queryNodes(quiet.tenant, { typeId: quiet.typeId });
    expect(answer.ok).toBe(true);

    release(undefined);
    const results = await Promise.all(crowd);
    expect(holding).toBe(CAP);
    const served = results.filter((result) => result.ok);
    const busy = results.filter((result) => !result.ok);
    expect(served).toHaveLength(CAP);
    expect(busy).toHaveLength(CROWD - CAP);
    for (const result of busy) {
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'engine.unavailable',
          retryable: true,
          issues: [{ path: 'query', code: 'engine.query_busy' }],
        },
      });
    }
    const again = await held.engine.queryNodes(crowded.tenant, { typeId: crowded.typeId });
    expect(again.ok).toBe(true);
  });

  it('a timed out query is a stable error with no partial page', async () => {
    const seeded = await stocked();
    // Scanning this many rows takes several ms, so 1 ms always runs out, and no lock on a table
    // every test file shares has to hold the query up.
    await bulkItems(seeded, 20_000);
    const quick = itemEngine(db, { config: { ...DEFAULT_ENGINE_CONFIG, queryTimeoutMs: 1 } });
    const page = await quick.engine.queryNodes(seeded.tenant, {
      typeId: seeded.typeId,
      filter: { field: NOTE, op: 'contains', value: 'needle' },
    });
    expect(page).toEqual({
      ok: false,
      error: { code: 'engine.unavailable', retryable: true, issues: [] },
    });
  });

  it('sends unnamed statements with every value bound', async () => {
    const seeded = await stocked();
    const value = `zq'mark`;
    await addItem(built, seeded, { [NAME]: value });
    const spy = vi.spyOn(pg.Client.prototype, 'query');
    const page = await built.engine.queryNodes(seeded.tenant, {
      typeId: seeded.typeId,
      filter: {
        or: [
          { field: NAME, op: 'eq', value },
          { field: NOTE, op: 'eq', value },
        ],
      },
    });
    const sent = spy.mock.calls.map((call): unknown => call[0]);
    spy.mockRestore();
    expect(page.ok).toBe(true);
    expect(sent.length).toBeGreaterThan(2);
    expect(statementProblems(sent, 'zq')).toEqual([]);
  });

  it('the capture catches a named statement and a value in the text', () => {
    expect(statementProblems([{ name: 'list', text: 'select 1' }], 'zq')).toEqual(['named: list']);
    expect(statementProblems([`select 'zq'`], 'zq')).toEqual([`in text: select 'zq'`]);
  });

  it('logs ids and counts, never a filter value', async () => {
    const seeded = await stocked();
    const lines: string[] = [];
    const logger = {
      info: (event: string, fields: object) => lines.push(event + JSON.stringify(fields)),
      warn: (event: string, fields: object) => lines.push(event + JSON.stringify(fields)),
    };
    const logged = itemEngine(db, { logger });
    const value = 'private-words';
    await logged.engine.queryNodes(seeded.tenant, {
      typeId: seeded.typeId,
      filter: { field: NAME, op: 'eq', value },
    });
    expect(lines.join('\n')).toContain('engine.query');
    expect(lines.join('\n')).toContain(seeded.organization);
    expect(lines.join('\n')).not.toContain(value);
  });

  it('opens the engine.query span', async () => {
    const seeded = await stocked();
    const spans: string[] = [];
    const traced = itemEngine(db, {
      tracer: {
        span: (name, _fields, work) => {
          spans.push(name);
          return work();
        },
        record: () => undefined,
      },
    });
    await traced.engine.queryNodes(seeded.tenant, { typeId: seeded.typeId });
    expect(spans).toContain('engine.query');
  });
});

describeWithStack('filter rows in a save', () => {
  const NAME = fieldId();
  const COUNT = fieldId();
  const TAGS = fieldId();
  const FIELDS = [
    textField(NAME, 'name', { filterable: true }),
    numberField(COUNT, 'count', { filterable: true, scale: 0 }),
    listField(TAGS, 'tags', { filterable: true }),
  ];

  const rowVersion = (node: NodeId) =>
    admin(`select xmin, ctid from app.node_filter_rows where node_id = '${node}';`);
  const slotsOf = (node: NodeId) =>
    admin(`select t1, i1, l2 from app.node_filter_rows where node_id = '${node}';`);

  it('makes a row when the node is made', async () => {
    const seeded = await seedItems();
    const node = await newItem(built, seeded);
    expect(await rowVersion(node)).not.toBe('');
  });

  it('writes no row when a save changes no slot', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, FIELDS);
    const node = await newItem(built, seeded);
    const first = await saveItem(built, seeded, node, null, { [NAME]: 'a', [COUNT]: '1' });
    const before = await rowVersion(node);

    const body = await saveItem(built, seeded, node, first.versionId, undefined, 'Other body.');
    expect(await rowVersion(node)).toBe(before);

    const same = await saveItem(built, seeded, node, body.versionId, { [COUNT]: '1', [NAME]: 'a' });
    expect(await rowVersion(node)).toBe(before);

    await saveItem(built, seeded, node, same.versionId, { [NAME]: 'b', [COUNT]: '1' });
    expect(await rowVersion(node)).not.toBe(before);
  });

  it('a body edit keeps the head values, and an explicit set replaces them', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, FIELDS);
    const node = await newItem(built, seeded);
    const first = await saveItem(built, seeded, node, null, { [NAME]: 'a', [COUNT]: '1' });
    const second = await saveItem(built, seeded, node, first.versionId);
    const head = await built.engine.getHead(seeded.tenant, node);
    expect(head.ok && head.value.fields).toEqual({ [NAME]: 'a', [COUNT]: '1' });

    await saveItem(built, seeded, node, second.versionId, { [NAME]: 'b' });
    expect(await slotsOf(node)).toBe('b||');
  });

  it('a rollback brings the old slots back with the old content', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, FIELDS);
    const node = await newItem(built, seeded);
    const first = await saveItem(built, seeded, node, null, { [NAME]: 'old', [COUNT]: '1' });
    const second = await saveItem(built, seeded, node, first.versionId, {
      [NAME]: 'new',
      [COUNT]: '2',
    });
    const back = await built.engine.rollback({
      tenant: seeded.tenant,
      nodeId: node,
      toVersionId: first.versionId,
      expectedHeadVersionId: second.versionId,
      actor: ACTOR,
      idempotencyKey: key(),
    });
    expect(back.ok).toBe(true);
    expect(await slotsOf(node)).toBe('old|1|');
    const page = await list(seeded, { filter: { field: NAME, op: 'eq', value: 'old' } });
    expect(page.items.map((item) => item.nodeId)).toEqual([node]);
  });

  it('commits slots and head together or not at all', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, FIELDS);
    const node = await newItem(built, seeded);
    const first = await saveItem(built, seeded, node, null, { [NAME]: 'kept' });
    // The value cannot cast to this column, so the slot write fails after the version insert
    // and the head update have both run.
    await admin(`update app.content_types
      set filter_slots = jsonb_set(filter_slots, '{${NAME},column}', '"d2"')
      where id = '${seeded.typeId}';`);
    await expect(
      saveItem(built, seeded, node, first.versionId, { [NAME]: 'lost' }),
    ).rejects.toThrow();
    const head = await built.engine.getHead(seeded.tenant, node);
    expect(head.ok && head.value.versionId).toBe(first.versionId);
    expect(head.ok && head.value.fields).toEqual({ [NAME]: 'kept' });
    expect(await slotsOf(node)).toBe('kept||');
  });

  it('a slot write that fails after the head update loses the head update too', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, FIELDS);
    const node = await newItem(built, seeded);
    const parse = parseClient();
    const content = await tree(parse, seeded, 'Body.');
    const real = itemEngine(db).engine;
    const crashing = createEngine({
      store: {
        ...databaseStore(db, DEFAULT_ENGINE_CONFIG),
        tenant: (tenant, work) =>
          withTenant(db, tenant, async (tx) => {
            await work(tx);
            throw new Error('crash after the last statement');
          }),
      },
      parse,
      parsePolicy: PARSE_POLICY,
      flags: { evaluate: () => Promise.resolve({ value: true }) },
    });
    await expect(
      crashing.saveDraft({
        tenant: seeded.tenant,
        nodeId: node,
        expectedHeadVersionId: null,
        content,
        origin: 'human',
        actor: ACTOR,
        idempotencyKey: key(),
        fields: { [NAME]: 'never' },
      }),
    ).rejects.toThrow();
    expect(await slotsOf(node)).toBe('||');
    const head = await real.getHead(seeded.tenant, node);
    expect(head.ok && head.value.versionId).toBeNull();
  });

  it('a replay with other fields is a conflict', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, FIELDS);
    const node = await newItem(built, seeded);
    const content = await tree(built.parse, seeded, 'Body.');
    const idempotencyKey = key();
    const send = (fields: Record<string, unknown>) =>
      built.engine.saveDraft({
        tenant: seeded.tenant,
        nodeId: node,
        expectedHeadVersionId: null,
        content,
        origin: 'human',
        actor: ACTOR,
        idempotencyKey,
        fields,
      });
    const first = await send({ [NAME]: 'a' });
    expect(await send({ [NAME]: 'a' })).toEqual(first);
    expect(await send({ [NAME]: 'b' })).toMatchObject({
      ok: false,
      error: { code: 'engine.idempotency_conflict' },
    });
  });

  it('a list refuses its 33rd value', async () => {
    const seeded = await seedItems();
    await declare(built, seeded, FIELDS);
    const node = await newItem(built, seeded);
    const values = (count: number) =>
      Array.from({ length: count }, (_, at) => String(at).padStart(32, 'x'));
    const fits = await saveItem(built, seeded, node, null, {
      [TAGS]: values(32),
    });
    await expect(
      saveItem(built, seeded, node, fits.versionId, { [TAGS]: values(33) }),
    ).rejects.toThrow('engine.field_invalid');
  });

  it('refuses to declare a list that could hold 33 values', async () => {
    const seeded = await seedItems();
    const done = await built.engine.declareSchema({
      tenant: seeded.tenant,
      typeId: seeded.typeId,
      schema: schemaOf(seeded, [listField(fieldId(), 'tags', { filterable: true, maxItems: 33 })]),
    });
    expect(done).toMatchObject({
      ok: false,
      error: { code: 'engine.validation_failed' },
    });
  });

  it.each([
    ['a lone surrogate', '\ud800'],
    ['a NUL', 'a\0b'],
  ])('refuses a label holding %s and stores nothing', async (_name, label) => {
    const seeded = await seedItems();
    const field = textField(fieldId(), 'title', { filterable: true });
    const done = await built.engine.declareSchema({
      tenant: seeded.tenant,
      typeId: seeded.typeId,
      schema: schemaOf(seeded, [{ ...field, label }]),
    });
    expect(done).toMatchObject({
      ok: false,
      error: {
        code: 'engine.validation_failed',
        issues: [{ path: 'fields.0.label', code: 'schema.malformed' }],
      },
    });
    const page = await built.engine.queryNodes(seeded.tenant, { typeId: seeded.typeId });
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.value.items).toEqual([]);
  });

  it('the widest row a definition allows fits the index', async () => {
    const seeded = await seedItems();
    const [a, b, c, d, e] = [fieldId(), fieldId(), fieldId(), fieldId(), fieldId()] as [
      FieldId,
      FieldId,
      FieldId,
      FieldId,
      FieldId,
    ];
    await declare(built, seeded, [
      ...[a, b, c, d].map((id, at) =>
        textField(id, `f${String(at)}`, { filterable: true, maxLength: 256 }),
      ),
      listField(e, 'tags', { filterable: true }),
    ]);
    // Hex of random bytes barely compresses, which is the case the limit is about.
    const noise = (bytes: number) =>
      Array.from({ length: bytes }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    await addItem(built, seeded, {
      [a]: noise(256),
      [b]: noise(256),
      [c]: noise(256),
      [d]: noise(256),
      [e]: Array.from({ length: 32 }, () => noise(32)),
    });
  });

  it('a save is refused past writes off, and declare too', async () => {
    const seeded = await seedItems();
    const off = itemEngine(db, {
      flags: { evaluate: () => Promise.resolve({ value: false }) },
    });
    const done = await off.engine.declareSchema({
      tenant: seeded.tenant,
      typeId: seeded.typeId,
      schema: schemaOf(seeded, FIELDS),
    });
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.forbidden' } });
    const page = await off.engine.queryNodes(seeded.tenant, { typeId: seeded.typeId });
    expect(page.ok).toBe(true);
  });
});
