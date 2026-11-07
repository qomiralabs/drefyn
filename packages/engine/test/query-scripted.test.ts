import { DbError } from '@drefyn/db';
import type { ContentSchema, FieldDef, FieldId, TypeId } from '@drefyn/schema';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKFILL_BATCH,
  BACKFILL_PAUSE_MS,
  createEngine,
  DEFAULT_ENGINE_CONFIG,
  runFilterBackfill,
  type EngineDeps,
  type EngineLogger,
} from '../src/index.ts';
import { assignSlots, type SlotMap } from '../src/filter-slots.ts';
import { scriptedStore, type Responder, type Statement } from './support/scripted-store.ts';

const tenant: TenantRef = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8001'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8002'),
};
const TYPE = '01890a5d-ac96-774b-bcce-b302099a8005';
const id = (n: number) => `01890a5d-ac96-774b-bcce-${String(n).padStart(12, '0')}` as FieldId;
const NAME = id(1);
const COUNT = id(2);
const WHEN = id(3);
const NOTE = id(4);
const NODE = id(5);
const UNSLOTTED_WHEN = id(7);

const MAX_CURSOR = 256;

const FIELDS: readonly FieldDef[] = [
  {
    id: NAME,
    apiName: 'name',
    label: 'Name',
    required: false,
    filterable: true,
    sortable: true,
    kind: 'text',
    maxLength: 64,
  },
  {
    id: COUNT,
    apiName: 'count',
    label: 'Count',
    required: false,
    filterable: true,
    sortable: true,
    kind: 'number',
    scale: 0,
  },
  {
    id: WHEN,
    apiName: 'when',
    label: 'When',
    required: false,
    filterable: true,
    sortable: true,
    kind: 'date',
    withTime: true,
  },
  { id: NOTE, apiName: 'note', label: 'Note', required: false, kind: 'text', maxLength: 64 },
  {
    id: UNSLOTTED_WHEN,
    apiName: 'seen',
    label: 'Seen',
    required: false,
    kind: 'date',
    withTime: true,
  },
];

const SCHEMA: ContentSchema = {
  typeId: TYPE as TypeId,
  apiName: 'item',
  version: 1,
  fields: FIELDS,
  deprecated: [],
  retired: [],
};

const slotsOf = (schema: ContentSchema, prior: SlotMap = {}): SlotMap => {
  const plan = assignSlots(schema, prior, false);
  if (!plan.ok) throw new Error(plan.error.code);
  return plan.value.slots;
};
const SLOTS = slotsOf(SCHEMA);

const typeRow = (over: object = {}) => ({
  content_schema: SCHEMA,
  filter_slots: SLOTS,
  ...over,
});

const nodeRow = {
  id: NODE,
  family: 'studio_item',
  type_id: TYPE,
  lifecycle: 'draft',
  slug: null,
  head_version_id: null,
  updated_at: new Date(0),
};

interface Script {
  readonly type?: object | null;
  readonly page?: readonly object[];
  readonly nodes?: readonly object[];
  readonly items?: number;
  // The node a cursor names, or null when no such node is found.
  readonly anchor?: object | null;
}

const answering =
  ({
    type = typeRow(),
    page = [],
    nodes = [nodeRow],
    items = 0,
    anchor = { anchor_value: null },
  }: Script): Responder =>
  ({ sql }: Statement) => {
    if (sql.includes('from "content_types"')) {
      return type === null ? [] : [type as Record<string, unknown>];
    }
    if (sql.includes('count(*) as items')) return [{ items }];
    if (sql.includes('as anchor_value')) {
      return anchor === null ? [] : [anchor as Record<string, unknown>];
    }
    if (sql.includes('order by')) return page as Record<string, unknown>[];
    if (sql.includes('from "nodes"')) return nodes as Record<string, unknown>[];
    return [];
  };

const deps = (respond: Responder, over: Partial<EngineDeps> = {}) => {
  const scripted = scriptedStore(respond);
  const engine = createEngine({
    store: scripted.store,
    parse: { print: vi.fn() },
    parsePolicy: {
      version: 1,
      components: [],
      rawHtml: 'sanitize',
      remoteImages: 'proxy',
      linkProtocols: ['https'],
    },
    flags: { evaluate: () => Promise.resolve({ value: true }) },
    ...over,
  });
  return { engine, ...scripted };
};

const pageSql = (statements: readonly Statement[]) =>
  statements.find((statement) => statement.sql.includes('order by'));

const anchorSql = (statements: readonly Statement[]) =>
  statements.find((statement) => statement.sql.includes('as anchor_value'));

const encoded = (value: unknown) =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

describe('queryNodes without a server', () => {
  it('refuses bad input before reading anything', async () => {
    const { engine, statements } = deps(answering({}));
    const page = await engine.queryNodes(tenant, { typeId: 'x' });
    expect(page).toMatchObject({ ok: false, error: { code: 'engine.validation_failed' } });
    expect(statements).toEqual([]);
  });

  it('answers not found for an unknown type', async () => {
    const { engine } = deps(answering({ type: null }));
    const page = await engine.queryNodes(tenant, { typeId: TYPE });
    expect(page).toMatchObject({ ok: false, error: { code: 'engine.not_found' } });
  });

  it('names the tenant in every statement it writes', async () => {
    const { engine, statements } = deps(answering({ page: [{ id: NODE }] }));
    await engine.queryNodes(tenant, { typeId: TYPE });
    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const { parameters } of statements) {
      expect(parameters).toContain(tenant.organizationId);
      expect(parameters).toContain(tenant.projectId);
    }
  });

  it('stays on the covering key for a declared filter', async () => {
    const { engine, statements } = deps(answering({}));
    await engine.queryNodes(tenant, {
      typeId: TYPE,
      filter: { field: NAME, op: 'eq', value: 'a' },
    });
    const sent = pageSql(statements)?.sql ?? '';
    expect(sent).toContain('app.node_filter_rows f');
    expect(sent).not.toContain('head_fields');
    expect(statements.some(({ sql }) => sql.includes('count(*)'))).toBe(false);
  });

  it('counts only when a scan is on the table, and stops one row past the limit', async () => {
    const { engine, statements } = deps(answering({ items: 3 }));
    await engine.queryNodes(tenant, {
      typeId: TYPE,
      filter: { field: NOTE, op: 'eq', value: 'a' },
    });
    const count = statements.find(({ sql }) => sql.includes('count(*)'));
    expect(count?.parameters).toContain(20_001);
    expect(pageSql(statements)?.sql).toContain('app.nodes n');
    expect(pageSql(statements)?.sql).toContain('n.deleted_at is null');
  });

  it('runs inside the configured timeout', async () => {
    const seen: unknown[] = [];
    const inner = scriptedStore(answering({}));
    const { engine } = deps(answering({}), {
      store: {
        tenant: (ref, work, options) => {
          seen.push(options);
          return inner.store.tenant(ref, work);
        },
      },
      config: { ...DEFAULT_ENGINE_CONFIG, queryTimeoutMs: 1234 },
    });
    await engine.queryNodes(tenant, { typeId: TYPE });
    expect(seen).toEqual([{ timeoutMs: 1234 }]);
  });

  it('turns a statement timeout into one retryable error and no page', async () => {
    const { engine, ends } = deps(() => {
      throw new DbError('DB_TIMEOUT', 'timed out');
    });
    const page = await engine.queryNodes(tenant, { typeId: TYPE });
    expect(page).toEqual({
      ok: false,
      error: { code: 'engine.unavailable', retryable: true, issues: [] },
    });
    expect(ends).toEqual(['rollback']);
  });

  it('continues from a cursor on each column type', async () => {
    const rows = [{ id: NODE }, { id: id(6) }];
    for (const [field, value, cast] of [
      [NAME, 'b', '::text'],
      [COUNT, '12', '::bigint'],
      [WHEN, '2026-01-01T00:00:00+00:00', '::timestamptz'],
    ] as const) {
      const first = deps(answering({ page: rows }));
      const page = await first.engine.queryNodes(tenant, {
        typeId: TYPE,
        sort: { field, direction: 'desc' },
        limit: 1,
      });
      if (!page.ok || page.value.nextCursor === null) throw new Error('no cursor');
      const next = deps(answering({ anchor: { anchor_value: value } }));
      const after = await next.engine.queryNodes(tenant, {
        typeId: TYPE,
        sort: { field, direction: 'desc' },
        cursor: page.value.nextCursor,
      });
      expect(after.ok).toBe(true);
      const sent = pageSql(next.statements);
      expect(sent?.sql).toContain(cast);
      expect(sent?.sql).toContain(' < ');
      expect(sent?.sql).toContain('desc nulls last');
      expect(sent?.parameters).toContain(value);
    }
  });

  it('keeps the sort value out of the cursor', async () => {
    const value = 'a customer value';
    const { engine } = deps(
      answering({
        page: [
          { id: NODE, sort_value: value },
          { id: id(6), sort_value: value },
        ],
      }),
    );
    const page = await engine.queryNodes(tenant, { typeId: TYPE, sort: { field: NAME }, limit: 1 });
    if (!page.ok || page.value.nextCursor === null) throw new Error('no cursor');
    const held: unknown = JSON.parse(Buffer.from(page.value.nextCursor, 'base64url').toString());
    expect(held).toEqual({ s: NAME, d: 'asc', n: NODE });
  });

  it('reads a sort value back from the node the cursor names, in this tenant', async () => {
    const next = deps(answering({ anchor: { anchor_value: 'b' } }));
    const cursor = encoded({ s: NAME, d: 'asc', n: NODE });
    await next.engine.queryNodes(tenant, { typeId: TYPE, sort: { field: NAME }, cursor });
    const sent = anchorSql(next.statements);
    expect(sent?.sql).toContain('app.node_filter_rows f');
    expect(sent?.parameters).toEqual(
      expect.arrayContaining([tenant.organizationId, tenant.projectId, TYPE, NODE]),
    );
  });

  it('finds a deleted node on the scan route, so a walk can pass it', async () => {
    const next = deps(answering({ items: 3 }));
    const cursor = encoded({ s: null, d: 'desc', n: NODE });
    await next.engine.queryNodes(tenant, {
      typeId: TYPE,
      filter: { field: NOTE, op: 'eq', value: 'a' },
      cursor,
    });
    const sent = anchorSql(next.statements)?.sql;
    expect(sent).toContain('app.nodes n');
    expect(sent).not.toContain('deleted_at');
  });

  it('continues past a null sort value inside the nulls', async () => {
    const rows = [{ id: NODE }, { id: id(6) }];
    const first = deps(answering({ page: rows }));
    const page = await first.engine.queryNodes(tenant, {
      typeId: TYPE,
      sort: { field: NAME },
      limit: 1,
    });
    if (!page.ok || page.value.nextCursor === null) throw new Error('no cursor');
    const next = deps(answering({}));
    await next.engine.queryNodes(tenant, {
      typeId: TYPE,
      sort: { field: NAME },
      cursor: page.value.nextCursor,
    });
    expect(pageSql(next.statements)?.sql).toContain('is null and');
  });

  it('continues a default list on the id alone', async () => {
    const rows = [{ id: NODE }, { id: id(6) }];
    const first = deps(answering({ page: rows }));
    const page = await first.engine.queryNodes(tenant, { typeId: TYPE, limit: 1 });
    if (!page.ok || page.value.nextCursor === null) throw new Error('no cursor');
    const next = deps(answering({}));
    await next.engine.queryNodes(tenant, { typeId: TYPE, cursor: page.value.nextCursor });
    expect(pageSql(next.statements)?.parameters).toContain(NODE);
  });

  it.each<[string, string]>([
    ['text that is not base64 of JSON', 'not a cursor'],
    ['JSON that is not an object', encoded('null')],
    ['an array', encoded([NAME, 'asc', NODE])],
    ['a missing node', encoded({ s: NAME, d: 'asc' })],
    ['a node that is not an id', encoded({ s: NAME, d: 'asc', n: `'; drop` })],
    ['a direction out of the list', encoded({ s: NAME, d: 'up', n: NODE })],
    [
      'a sort value, which cursors no longer carry',
      encoded({ s: NAME, d: 'asc', v: 'a', n: NODE }),
    ],
    ['a year 0000 sort value', encoded({ s: WHEN, d: 'asc', v: '0000-01-01T00:00:00Z', n: NODE })],
    ['an offset Postgres refuses', encoded({ s: WHEN, d: 'asc', v: 'x+23:00', n: NODE })],
    ['a NUL', encoded({ s: NAME, d: 'asc', v: 'a\u0000', n: NODE })],
  ])('refuses %s as a cursor before any page is read', async (_name, cursor) => {
    const { engine, statements } = deps(answering({}));
    const page = await engine.queryNodes(tenant, {
      typeId: TYPE,
      sort: { field: NAME, direction: 'asc' },
      cursor,
    });
    expect(page).toEqual({
      ok: false,
      error: {
        code: 'engine.validation_failed',
        retryable: false,
        issues: [{ path: 'cursor', code: 'engine.cursor_invalid' }],
      },
    });
    expect(pageSql(statements)).toBeUndefined();
  });

  it.each([
    ['sorted', { sort: { field: NAME } }, { s: NAME, d: 'asc', n: NODE }],
    ['unsorted', {}, { s: null, d: 'desc', n: NODE }],
  ])('refuses a %s cursor naming a node this tenant cannot see', async (_name, query, held) => {
    const { engine, statements } = deps(answering({ anchor: null }));
    const page = await engine.queryNodes(tenant, {
      typeId: TYPE,
      ...query,
      cursor: encoded(held),
    });
    expect(page).toMatchObject({
      ok: false,
      error: { issues: [{ code: 'engine.cursor_invalid' }] },
    });
    expect(pageSql(statements)).toBeUndefined();
  });

  it('has room for the longest cursor it can issue, and refuses far past that unread', async () => {
    const longest = encoded({ s: NAME, d: 'desc', n: NODE });
    const { engine, statements } = deps(answering({ anchor: null }));
    const query = { typeId: TYPE, sort: { field: NAME, direction: 'desc' } } as const;
    const known = await engine.queryNodes(tenant, { ...query, cursor: longest });
    expect(known).toMatchObject({ error: { issues: [{ code: 'engine.cursor_invalid' }] } });
    statements.length = 0;
    const long = await engine.queryNodes(tenant, { ...query, cursor: 'x'.repeat(MAX_CURSOR + 1) });
    expect(long).toMatchObject({ ok: false, error: { code: 'engine.validation_failed' } });
    expect(statements).toEqual([]);
  });

  it('never throws on whatever comes back as a cursor', async () => {
    // Any code point, lone surrogates included. The 'binary' unit leaves those out, and on first
    // use it builds a table of all of Unicode, which took this test past its limit on CI.
    const unit = fc.integer({ min: 0, max: 0x10ffff }).map((point) => String.fromCodePoint(point));
    const shapes = fc.oneof(
      fc.string({ unit, minLength: 1, maxLength: 64 }),
      fc.json().map(encoded),
      fc
        .record({
          s: fc.option(fc.string({ unit })),
          d: fc.string(),
          v: fc.option(fc.string({ unit })),
          n: fc.string(),
        })
        .map(encoded),
    );
    const { engine } = deps(answering({ anchor: null }));
    await fc.assert(
      fc.asyncProperty(shapes, async (cursor) => {
        const page = await engine.queryNodes(tenant, {
          typeId: TYPE,
          sort: { field: WHEN },
          cursor,
        });
        const code = cursor.length > MAX_CURSOR ? 'too_big' : 'engine.cursor_invalid';
        expect(page).toMatchObject({
          ok: false,
          error: { code: 'engine.validation_failed', issues: [{ code }] },
        });
      }),
    );
  });

  it('reads an unreadable stored date as missing on a scan, and does not throw', async () => {
    const { engine, statements } = deps(answering({ items: 3 }));
    await engine.queryNodes(tenant, {
      typeId: TYPE,
      filter: { field: UNSLOTTED_WHEN, op: 'exists' },
    });
    expect(pageSql(statements)?.sql).toMatch(/case when starts_with\(.* then null/);
  });

  it('skips a node deleted since its row was read, and keeps order', async () => {
    const second = { ...nodeRow, id: id(6) };
    const { engine } = deps(
      answering({
        page: [{ id: id(6) }, { id: id(7), sort_value: null }, { id: NODE }],
        nodes: [nodeRow, second],
      }),
    );
    const page = await engine.queryNodes(tenant, { typeId: TYPE });
    expect(page.ok && page.value.items.map((item) => item.nodeId)).toEqual([id(6), NODE]);
  });

  it('reports fields still filling and takes the scan for them', async () => {
    const filling: SlotMap = { ...SLOTS, [NAME]: { column: 't1', state: 'backfilling' } };
    const { engine, statements } = deps(
      answering({ type: typeRow({ filter_slots: filling }), items: 1 }),
    );
    const page = await engine.queryNodes(tenant, {
      typeId: TYPE,
      sort: { field: NAME },
    });
    expect(page.ok && page.value.backfilling).toEqual([NAME]);
    expect(pageSql(statements)?.sql).toContain('head_fields');
  });

  it('refuses a sort on a slot being cleared', async () => {
    const clearing: SlotMap = { ...SLOTS, [NAME]: { column: 't1', state: 'clearing' } };
    const { engine } = deps(answering({ type: typeRow({ filter_slots: clearing }) }));
    const page = await engine.queryNodes(tenant, { typeId: TYPE, sort: { field: NAME } });
    expect(page).toMatchObject({
      ok: false,
      error: { issues: [{ code: 'engine.sort_not_declared' }] },
    });
  });

  it('throws on a stored definition that does not parse, as that is damage', async () => {
    const { engine } = deps(answering({ type: typeRow({ content_schema: { nope: true } }) }));
    await expect(engine.queryNodes(tenant, { typeId: TYPE })).rejects.toThrow('does not parse');
  });
});

describe('declareSchema without a server', () => {
  const declare = (engine: ReturnType<typeof deps>['engine'], schema: unknown) =>
    engine.declareSchema({ tenant, typeId: TYPE, schema });

  const first = (over: object = {}) =>
    answering({ type: { id: TYPE, content_schema: null, filter_slots: {}, ...over } });

  it('answers not found for a type this tenant cannot see', async () => {
    const { engine } = deps(answering({ type: null }));
    expect(await declare(engine, SCHEMA)).toMatchObject({
      ok: false,
      error: { code: 'engine.not_found' },
    });
  });

  it('refuses a definition of another type', async () => {
    const { engine } = deps(first());
    const other = { ...SCHEMA, typeId: id(9) };
    expect(await declare(engine, other)).toMatchObject({
      ok: false,
      error: { issues: [{ code: 'engine.type_mismatch' }] },
    });
  });

  it('refuses a malformed definition with the schema codes', async () => {
    const { engine, ends } = deps(first());
    expect(await declare(engine, { fields: 'no' })).toMatchObject({
      ok: false,
      error: { code: 'engine.validation_failed' },
    });
    expect(ends).toEqual(['rollback']);
  });

  it.each([
    ['a lone surrogate', '\ud800'],
    ['a NUL', 'a\0b'],
  ])('refuses a label holding %s before anything is written', async (_name, label) => {
    const { engine, statements, ends } = deps(first());
    const [field] = SCHEMA.fields;
    const hostile = { ...SCHEMA, fields: [{ ...field, label }, ...SCHEMA.fields.slice(1)] };
    expect(await declare(engine, hostile)).toMatchObject({
      ok: false,
      error: {
        code: 'engine.validation_failed',
        issues: [{ path: 'fields.0.label', code: 'schema.malformed' }],
      },
    });
    expect(statements.some(({ sql }) => sql.startsWith('update'))).toBe(false);
    expect(ends).toEqual(['rollback']);
  });

  it('refuses a second first version', async () => {
    const { engine } = deps(first());
    expect(await declare(engine, { ...SCHEMA, version: 2 })).toMatchObject({
      ok: false,
      error: { code: 'engine.validation_failed' },
    });
  });

  it('stores the definition and the slots, and queues nothing on an empty type', async () => {
    const { engine, statements, ends } = deps(first());
    const done = await declare(engine, SCHEMA);
    expect(done).toEqual({ ok: true, value: { typeId: TYPE, version: 1, backfills: 0 } });
    expect(statements.some(({ sql }) => sql.startsWith('update "content_types"'))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes('filter_backfills'))).toBe(false);
    expect(ends).toEqual(['commit']);
  });

  it('refuses writes when the flag is off', async () => {
    const { engine, statements } = deps(first(), {
      flags: { evaluate: () => Promise.resolve({ value: false }) },
    });
    expect(await declare(engine, SCHEMA)).toMatchObject({
      ok: false,
      error: { code: 'engine.forbidden' },
    });
    expect(statements).toEqual([]);
  });

  it('passes a slot refusal on with the field it names', async () => {
    const five = (n: number): FieldDef => ({
      id: id(100 + n),
      apiName: `text${String(n)}`,
      label: 'T',
      required: false,
      filterable: true,
      kind: 'text',
      maxLength: 8,
    });
    const held: SlotMap = {
      [id(90)]: { column: 't1', state: 'clearing' },
      [id(91)]: { column: 't2', state: 'clearing' },
      [id(92)]: { column: 't3', state: 'clearing' },
      [id(93)]: { column: 't4', state: 'clearing' },
      [id(94)]: { column: 't5', state: 'clearing' },
    };
    const kept = FIELDS[3];
    if (kept === undefined) throw new Error('no field');
    const prior = { ...SCHEMA, fields: [kept] };
    const { engine } = deps((statement) => {
      if (statement.sql.includes('from "content_types"')) {
        return [{ id: TYPE, content_schema: prior, filter_slots: held }];
      }
      if (statement.sql.includes('from "node_filter_rows"')) return [{ node_id: NODE }];
      return [];
    });
    const done = await declare(engine, { ...prior, version: 2, fields: [kept, five(1)] });
    expect(done).toMatchObject({
      ok: false,
      error: { issues: [{ code: 'engine.filter_slot_busy', fieldId: id(101) }] },
    });
  });
});

describe('the filter backfill without a server', () => {
  const job = {
    id: id(50),
    type_id: TYPE,
    field_id: NAME,
    slot_column: 't1',
    action: 'fill',
    after_node_id: null,
    started_at: null,
  };

  const backfilling = (over: object = {}, batch = 0): Responder => {
    return ({ sql }) => {
      if (sql.includes('from "filter_backfills"')) return [{ ...job, ...over }];
      if (sql.includes('from "content_types"')) {
        return [{ content_schema: SCHEMA, filter_slots: SLOTS }];
      }
      if (sql.includes('from "nodes"')) {
        return Array.from({ length: batch }, (_, at) => ({ id: id(1000 + at) }));
      }
      return [];
    };
  };

  it('stops at idle with nothing queued', async () => {
    const { engine } = deps(() => []);
    expect(await engine.backfillFilters(tenant)).toEqual({ ok: true, value: 'idle' });
  });

  it('turns the one running rule into waiting', async () => {
    const { engine } = deps(({ sql }) => {
      if (sql.startsWith('update "filter_backfills"')) {
        throw new DbError('DB_UNIQUE_VIOLATION', 'taken');
      }
      return backfilling()({ sql, parameters: [] });
    });
    expect(await engine.backfillFilters(tenant)).toEqual({ ok: true, value: 'waiting' });
  });

  it('waits rather than queue behind a declare that holds the type', async () => {
    const { engine, statements } = deps(({ sql }) =>
      sql.includes('from "filter_backfills"') ? [job] : [],
    );
    expect(await engine.backfillFilters(tenant)).toEqual({ ok: true, value: 'waiting' });
    expect(statements.some(({ sql }) => sql.startsWith('update'))).toBe(false);
  });

  it('lets any other failure through as a retryable refusal or a throw', async () => {
    const busy = deps(() => {
      throw new DbError('DB_TIMEOUT', 'timed out');
    });
    expect(await busy.engine.backfillFilters(tenant)).toMatchObject({
      ok: false,
      error: { code: 'engine.unavailable' },
    });
    const broken = deps(() => {
      throw new Error('a bug');
    });
    await expect(broken.engine.backfillFilters(tenant)).rejects.toThrow('a bug');
  });

  it('keeps going while a batch is full, and moves the cursor', async () => {
    const { engine, statements } = deps(
      backfilling({ after_node_id: id(999), started_at: new Date(0) }, BACKFILL_BATCH),
    );
    expect(await engine.backfillFilters(tenant)).toEqual({ ok: true, value: 'running' });
    expect(statements.some(({ parameters }) => parameters.includes(id(999)))).toBe(true);
    const cursor = statements.at(-1);
    expect(cursor?.sql).toContain('after_node_id');
    expect(cursor?.parameters).toContain(id(1000 + BACKFILL_BATCH - 1));
  });

  it('finishes a short batch: the slot turns ready in that transaction', async () => {
    const { engine, statements, ends } = deps(backfilling({}, 3));
    expect(await engine.backfillFilters(tenant)).toEqual({ ok: true, value: 'finished' });
    const flipped = statements.find(({ sql }) => sql.startsWith('update "content_types"'));
    expect(flipped).toBeDefined();
    expect(ends).toEqual(['commit']);
  });

  it('a clear writes null and drops the entry when done', async () => {
    const { engine, statements } = deps(backfilling({ action: 'clear' }, 3));
    expect(await engine.backfillFilters(tenant)).toEqual({ ok: true, value: 'finished' });
    const write = statements.find(({ sql }) => sql.includes('update app.node_filter_rows'));
    expect(write?.sql).toContain('= null');
    const flipped = statements.find(({ sql }) => sql.startsWith('update "content_types"'));
    expect(JSON.stringify(flipped?.parameters)).not.toContain(NAME);
  });

  it('writes nothing for an empty batch and still finishes', async () => {
    const { engine, statements } = deps(backfilling({}, 0));
    expect(await engine.backfillFilters(tenant)).toEqual({ ok: true, value: 'finished' });
    expect(statements.some(({ sql }) => sql.includes('update app.node_filter_rows'))).toBe(false);
  });

  it('refuses a bad tenant before any work', async () => {
    const { engine, statements } = deps(() => []);
    const done = await engine.backfillFilters({ organizationId: 'x' } as unknown as TenantRef);
    expect(done).toMatchObject({ ok: false, error: { code: 'engine.validation_failed' } });
    expect(statements).toEqual([]);
  });

  it('pacing pauses after each batch and stops on a refusal', async () => {
    const steps = [
      { ok: true, value: 'running' },
      { ok: true, value: 'finished' },
      { ok: false, error: { code: 'engine.unavailable', retryable: true, issues: [] } },
    ] as const;
    const backfillFilters = vi.fn(() =>
      Promise.resolve(steps[backfillFilters.mock.calls.length - 1]),
    );
    const wait = vi.fn(() => Promise.resolve());
    const done = await runFilterBackfill({ backfillFilters } as never, tenant, wait);
    expect(done).toMatchObject({ ok: false });
    expect(wait.mock.calls).toEqual([[BACKFILL_PAUSE_MS], [BACKFILL_PAUSE_MS]]);
  });

  it('logs the state with the tenant and no field values', async () => {
    const lines: string[] = [];
    const logger: EngineLogger = {
      info: (event, fields) => lines.push(event + JSON.stringify(fields)),
      warn: (event, fields) => lines.push(event + JSON.stringify(fields)),
    };
    const { engine } = deps(() => [], { logger });
    await engine.backfillFilters(tenant);
    expect(lines.join()).toContain('engine.filter_backfill');
    expect(lines.join()).toContain(tenant.organizationId);
  });
});

describe('queryNodes under load', () => {
  const CAP = 4;
  const other: TenantRef = { ...tenant, organizationId: organizationId(id(900)) };

  // Work waits at the gate, so the test decides what is in flight and no timing is involved.
  const gated = () => {
    const inner = scriptedStore(answering({}));
    const waiting: (() => void)[] = [];
    const entered: string[] = [];
    const watchers = new Map<number, () => void>();
    const store: EngineDeps['store'] = {
      tenant: (ref, work) =>
        inner.store.tenant(ref, async (tx) => {
          entered.push(ref.organizationId);
          watchers.get(entered.length)?.();
          await new Promise<void>((open) => waiting.push(open));
          return work(tx);
        }),
    };
    const release = () => {
      for (const open of waiting.splice(0)) open();
    };
    const arrived = (count: number) =>
      entered.length >= count
        ? Promise.resolve()
        : new Promise<void>((open) => watchers.set(count, open));
    return { store, entered, release, arrived };
  };

  const crowd = (engine: ReturnType<typeof deps>['engine'], size: number) =>
    Array.from({ length: size }, () => engine.queryNodes(tenant, { typeId: TYPE }));

  const held = (over: Partial<EngineDeps> = {}) => {
    const gate = gated();
    const { engine } = deps(answering({}), {
      store: gate.store,
      config: { ...DEFAULT_ENGINE_CONFIG, queryMaxInFlight: CAP },
      ...over,
    });
    return { engine, ...gate };
  };

  it('admits the cap out of a crowd and refuses the rest, retryable', async () => {
    const { engine, entered, release, arrived } = held();
    const running = crowd(engine, 500);
    await arrived(CAP);
    release();
    const results = await Promise.all(running);
    expect(entered).toHaveLength(CAP);
    expect(results.filter((result) => result.ok)).toHaveLength(CAP);
    const refused = results.filter((result) => !result.ok);
    expect(refused).toHaveLength(496);
    expect(refused[0]).toEqual({
      ok: false,
      error: {
        code: 'engine.unavailable',
        retryable: true,
        issues: [{ path: 'query', code: 'engine.query_busy' }],
      },
    });
  });

  it('leaves another organization its own places', async () => {
    const { engine, entered, release, arrived } = held();
    const running = [...crowd(engine, 50), engine.queryNodes(other, { typeId: TYPE })];
    await arrived(CAP + 1);
    expect(entered.filter((org) => org === other.organizationId)).toHaveLength(1);
    release();
    const results = await Promise.all(running);
    expect(results.at(-1)?.ok).toBe(true);
  });

  it('takes queries again once the crowd has gone', async () => {
    const { engine, release, arrived } = held();
    const running = crowd(engine, 20);
    await arrived(CAP);
    release();
    await Promise.all(running);
    const next = engine.queryNodes(tenant, { typeId: TYPE });
    await arrived(CAP + 1);
    release();
    expect((await next).ok).toBe(true);
  });

  it('gives a place back when a query is refused, times out or breaks', async () => {
    const failures = [
      () => {
        throw new Error('a bug');
      },
      () => {
        throw new DbError('DB_TIMEOUT', 'timed out');
      },
    ];
    for (const failure of failures) {
      const { engine } = deps(failure, {
        config: { ...DEFAULT_ENGINE_CONFIG, queryMaxInFlight: 1 },
      });
      await engine.queryNodes(tenant, { typeId: TYPE }).catch(() => undefined);
      const next = await engine
        .queryNodes(tenant, { typeId: TYPE })
        .catch((error: unknown) => error);
      expect(next).not.toMatchObject({ error: { issues: [{ code: 'engine.query_busy' }] } });
    }
    const missing = deps(answering({ type: null }), {
      config: { ...DEFAULT_ENGINE_CONFIG, queryMaxInFlight: 1 },
    });
    await missing.engine.queryNodes(tenant, { typeId: TYPE });
    const next = await missing.engine.queryNodes(tenant, { typeId: TYPE });
    expect(next).toMatchObject({ error: { code: 'engine.not_found' } });
  });

  it('does not count a query refused on its input', async () => {
    const { engine, entered } = held();
    const bad = await Promise.all(
      Array.from({ length: 20 }, () => engine.queryNodes(tenant, { typeId: 'x' })),
    );
    expect(bad.every((result) => !result.ok)).toBe(true);
    expect(entered).toEqual([]);
  });

  it('logs a busy refusal with ids and the cap, and no query text', async () => {
    const warn = vi.fn<EngineLogger['warn']>();
    const logger: EngineLogger = { info: vi.fn(), warn };
    const { engine, release, arrived } = held({ logger });
    const running = crowd(engine, CAP + 1);
    await arrived(CAP);
    release();
    await Promise.all(running);
    expect(warn).toHaveBeenCalledExactlyOnceWith('engine.query_busy', {
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      max_in_flight: CAP,
    });
  });
});
