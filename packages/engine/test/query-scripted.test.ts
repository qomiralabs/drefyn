import { DbError } from '@drefyn/db';
import type { ContentSchema, FieldDef, FieldId, TypeId } from '@drefyn/schema';
import { organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
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
}

const answering =
  ({ type = typeRow(), page = [], nodes = [nodeRow], items = 0 }: Script): Responder =>
  ({ sql }: Statement) => {
    if (sql.includes('from "content_types"')) {
      return type === null ? [] : [type as Record<string, unknown>];
    }
    if (sql.includes('count(*) as items')) return [{ items }];
    if (sql.includes('as sort_value')) return page as Record<string, unknown>[];
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
  statements.find((statement) => statement.sql.includes('as sort_value'));

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
    const { engine, statements } = deps(answering({ page: [{ id: NODE, sort_value: null }] }));
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
    const rows = [
      { id: NODE, sort_value: 'b' },
      { id: id(6), sort_value: 'c' },
    ];
    for (const [field, value, cast] of [
      [NAME, 'b', '::text'],
      [COUNT, '12', '::bigint'],
      [WHEN, '2026-01-01T00:00:00+00:00', '::timestamptz'],
    ] as const) {
      const first = deps(answering({ page: rows.map((row) => ({ ...row, sort_value: value })) }));
      const page = await first.engine.queryNodes(tenant, {
        typeId: TYPE,
        sort: { field, direction: 'desc' },
        limit: 1,
      });
      if (!page.ok || page.value.nextCursor === null) throw new Error('no cursor');
      const next = deps(answering({}));
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

  it('continues past a null sort value inside the nulls', async () => {
    const rows = [
      { id: NODE, sort_value: null },
      { id: id(6), sort_value: null },
    ];
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
    const rows = [
      { id: NODE, sort_value: null },
      { id: id(6), sort_value: null },
    ];
    const first = deps(answering({ page: rows }));
    const page = await first.engine.queryNodes(tenant, { typeId: TYPE, limit: 1 });
    if (!page.ok || page.value.nextCursor === null) throw new Error('no cursor');
    const next = deps(answering({}));
    await next.engine.queryNodes(tenant, { typeId: TYPE, cursor: page.value.nextCursor });
    expect(pageSql(next.statements)?.parameters).toContain(NODE);
  });

  it.each([
    ['a number column', COUNT, 'twelve'],
    ['a time column', WHEN, 'soon'],
    ['a NUL', NAME, 'a\u0000'],
  ])('refuses a cursor whose value does not fit %s', async (_name, field, v) => {
    const cursor = Buffer.from(
      JSON.stringify({ s: field, d: 'asc', v, n: '01890a5d-ac96-774b-bcce-b302099a8099' }),
    ).toString('base64url');
    const { engine } = deps(answering({}));
    const page = await engine.queryNodes(tenant, { typeId: TYPE, sort: { field }, cursor });
    expect(page).toMatchObject({
      ok: false,
      error: { issues: [{ code: 'engine.cursor_invalid' }] },
    });
  });

  it('skips a node deleted since its row was read, and keeps order', async () => {
    const second = { ...nodeRow, id: id(6) };
    const { engine } = deps(
      answering({
        page: [
          { id: id(6), sort_value: null },
          { id: id(7), sort_value: null },
          { id: NODE, sort_value: null },
        ],
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
