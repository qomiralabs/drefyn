import { DbError, type PublishedDatabase } from '@drefyn/db';
import type { ContentSchema, FieldDef, FieldId, TypeId } from '@drefyn/schema';
import { idOf, organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { describe, expect, it, vi } from 'vitest';
import {
  cachedTypes,
  createPublishedReader,
  publishedStore,
  storeTypes,
  type EngineLogger,
  type PublishedTypes,
} from '../src/index.ts';
import { assignSlots, type SlotMap } from '../src/filter-slots.ts';
import {
  scriptedPublishedStore,
  scriptedStore,
  type Responder,
  type Statement,
} from './support/scripted-store.ts';

const tenant: TenantRef = {
  organizationId: organizationId('01890a5d-ac96-774b-bcce-b302099a8001'),
  projectId: projectId('01890a5d-ac96-774b-bcce-b302099a8002'),
};
const TYPE = '01890a5d-ac96-774b-bcce-b302099a8005';
const id = (n: number) => `01890a5d-ac96-774b-bcce-${String(n).padStart(12, '0')}`;
const NAME = id(1) as FieldId;
const COUNT = id(2) as FieldId;
const NOTE = id(3) as FieldId;
const WHEN = id(4) as FieldId;
const NODE = idOf('nod', id(10));
const OTHER = idOf('nod', id(11));
const VERSION = idOf('ver', id(20));

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
  { id: NOTE, apiName: 'note', label: 'Note', required: false, kind: 'text', maxLength: 64 },
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
];

const SCHEMA: ContentSchema = {
  typeId: TYPE as TypeId,
  apiName: 'item',
  version: 1,
  fields: FIELDS,
  deprecated: [],
  retired: [],
};

const plan = assignSlots(SCHEMA, {}, false);
if (!plan.ok) throw new Error(plan.error.code);
const READY: SlotMap = plan.value.slots;
const FILLING: SlotMap = {
  ...READY,
  [WHEN]: { column: READY[WHEN]?.column ?? 'd1', state: 'backfilling' },
};

const typesOf = (slots: SlotMap | null, schema: unknown = SCHEMA): PublishedTypes => ({
  definition: () => Promise.resolve(slots === null ? null : { schema, slots }),
});

const versionRow = (over: object = {}) => ({
  node_id: NODE,
  type_id: TYPE,
  version_id: VERSION,
  is_current: true,
  content: { type: 'root', children: [] },
  fields: { [NAME]: 'x' },
  render_policy_version: 3,
  published_at: new Date(0),
  ...over,
});

interface Script {
  readonly version?: object | null;
  readonly page?: readonly object[];
  readonly current?: readonly object[];
  readonly anchor?: object | null;
  readonly fail?: Error;
}

const answering =
  ({
    version = versionRow(),
    page = [],
    current = [],
    anchor = { anchor_value: null },
    fail,
  }: Script): Responder =>
  ({ sql }: Statement) => {
    if (fail !== undefined) throw fail;
    if (sql.includes('as anchor_value')) {
      return anchor === null ? [] : [anchor as Record<string, unknown>];
    }
    if (sql.includes('order by')) return page as Record<string, unknown>[];
    if (sql.includes('"content"')) {
      return version === null ? [] : [version as Record<string, unknown>];
    }
    if (sql.includes('from "published_versions"')) return current as Record<string, unknown>[];
    return [];
  };

const reader = (
  script: Script = {},
  types: PublishedTypes = typesOf(READY),
  logger?: EngineLogger,
) => {
  const scripted = scriptedPublishedStore(answering(script));
  return {
    ...scripted,
    reader: createPublishedReader({
      store: scripted.store,
      types,
      ...(logger === undefined ? {} : { logger }),
    }),
  };
};

const leaf = (field: string, op: string, value?: unknown) => ({
  field,
  op,
  ...(value === undefined ? {} : { value }),
});

const cursorFor = (n: string, s: string | null = null, d = 'desc') =>
  Buffer.from(JSON.stringify({ s, d, n }), 'utf8').toString('base64url');

// Every statement a public read sends may name only the two published tables.
const DRAFT_TABLE =
  /\b(nodes|node_versions|node_filter_rows|content_types|chunks|chunk_embeddings|engine_outbox)\b/;

describe('getPublished', () => {
  it('reads the current version of the node, scoped to the tenant', async () => {
    const { reader: r, statements, ends } = reader();
    const found = await r.getPublished(tenant, NODE);
    expect(found).toEqual({
      ok: true,
      value: {
        nodeId: NODE,
        typeId: TYPE,
        versionId: VERSION,
        isCurrent: true,
        content: { type: 'root', children: [] },
        fields: { [NAME]: 'x' },
        renderPolicyVersion: 3,
        publishedAt: new Date(0),
      },
    });
    expect(statements).toHaveLength(1);
    const [statement] = statements;
    expect(statement?.sql).toContain('from "published_versions"');
    expect(statement?.sql).toContain('"is_current" = $4');
    expect(statement?.sql).not.toMatch(DRAFT_TABLE);
    expect(statement?.parameters).toEqual([tenant.organizationId, tenant.projectId, NODE, true]);
    expect(ends).toEqual(['commit']);
  });

  it('resolves a pin by version id among published rows only', async () => {
    const { reader: r, statements } = reader({ version: versionRow({ is_current: false }) });
    const found = await r.getPublished(tenant, NODE, { versionId: VERSION });
    expect(found.ok && found.value.isCurrent).toBe(false);
    expect(statements[0]?.sql).toContain('"version_id" = $4');
    expect(statements[0]?.sql).not.toContain('is_current" =');
    expect(statements[0]?.parameters).toEqual([
      tenant.organizationId,
      tenant.projectId,
      NODE,
      VERSION,
    ]);
  });

  it('says not_found when no published row matches, and rolls back', async () => {
    const { reader: r, ends } = reader({ version: null });
    const found = await r.getPublished(tenant, NODE, { versionId: VERSION });
    expect(found).toEqual({
      ok: false,
      error: { code: 'engine.not_found', retryable: false, issues: [] },
    });
    expect(ends).toEqual(['rollback']);
  });

  it.each([
    ['no project', { organizationId: tenant.organizationId }, NODE, undefined],
    ['a project that is no uuid', { ...tenant, projectId: 'p' }, NODE, undefined],
    ['an extra key', { ...tenant, userId: id(9) }, NODE, undefined],
    ['a node that is no uuid', tenant, 'nod_1', undefined],
    ['a pin with no version', tenant, NODE, {}],
    ['a pin with more', tenant, NODE, { versionId: VERSION, seq: 1 }],
  ])('refuses %s before any statement', async (_name, who, node, pin) => {
    const { reader: r, statements } = reader();
    const found = await r.getPublished(who as never, node as never, pin as never);
    expect(found.ok ? null : found.error.code).toBe('engine.validation_failed');
    expect(statements).toEqual([]);
  });

  it('answers a busy database as retryable', async () => {
    const { reader: r } = reader({ fail: new DbError('DB_TIMEOUT', 'slow') });
    const found = await r.getPublished(tenant, NODE);
    expect(found).toEqual({
      ok: false,
      error: { code: 'engine.unavailable', retryable: true, issues: [] },
    });
  });

  it('throws anything else, as a bug', async () => {
    const { reader: r } = reader({ fail: new Error('boom') });
    await expect(r.getPublished(tenant, NODE)).rejects.toThrow('boom');
  });

  it('logs ids and codes, never content', async () => {
    const logger = { info: vi.fn<EngineLogger['info']>(), warn: vi.fn<EngineLogger['warn']>() };
    await reader({}, typesOf(READY), logger).reader.getPublished(tenant, NODE);
    await reader({ version: null }, typesOf(READY), logger).reader.getPublished(tenant, NODE);
    expect(logger.info.mock.calls.map((call) => call[0])).toEqual([
      'engine.published_get',
      'engine.published_get.refused',
    ]);
    const fields = logger.info.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(fields).toMatchObject({
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      node_id: NODE,
      pinned: false,
      code: 'engine.not_found',
    });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('root');
  });
});

describe('listPublished', () => {
  const summary = (node: string, version: string) => ({
    node_id: node,
    type_id: TYPE,
    version_id: version,
    published_at: new Date(0),
  });

  it('pages the published filter rows and reads the current versions', async () => {
    const { reader: r, statements } = reader({
      page: [{ id: NODE }, { id: OTHER }],
      current: [summary(OTHER, id(21)), summary(NODE, VERSION)],
    });
    const found = await r.listPublished(tenant, {
      typeId: TYPE,
      filter: leaf(NAME, 'eq', 'x'),
      sort: { field: COUNT, direction: 'desc' },
      limit: 1,
    });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.items).toEqual([
      { nodeId: NODE, typeId: TYPE, versionId: VERSION, publishedAt: new Date(0) },
    ]);
    expect(found.value.nextCursor).toBe(cursorFor(NODE, COUNT));
    expect(statements[0]?.sql).toContain('from app.published_filter_rows f');
    expect(statements[1]?.sql).toContain('from "published_versions"');
    expect(statements[1]?.sql).toContain('"is_current" =');
    for (const statement of statements) expect(statement.sql).not.toMatch(DRAFT_TABLE);
  });

  it('leaves out a filter row whose node has no current version', async () => {
    const { reader: r } = reader({ page: [{ id: NODE }, { id: OTHER }], current: [] });
    const found = await r.listPublished(tenant, { typeId: TYPE });
    expect(found.ok && found.value).toEqual({ items: [], nextCursor: null });
  });

  it('reads no versions for an empty page', async () => {
    const { reader: r, statements } = reader({ page: [] });
    const found = await r.listPublished(tenant, { typeId: TYPE });
    expect(found.ok && found.value).toEqual({ items: [], nextCursor: null });
    expect(statements).toHaveLength(1);
  });

  it('continues from a cursor anchored on a published filter row', async () => {
    const { reader: r, statements } = reader({ anchor: { anchor_value: '7' } });
    const found = await r.listPublished(tenant, {
      typeId: TYPE,
      sort: { field: COUNT, direction: 'desc' },
      cursor: cursorFor(NODE, COUNT),
    });
    expect(found.ok).toBe(true);
    expect(statements[0]?.sql).toContain('as anchor_value');
    expect(statements[0]?.sql).toContain('from app.published_filter_rows f');
    expect(statements[0]?.parameters).toContain(NODE);
  });

  it('continues an unsorted list from a cursor', async () => {
    const { reader: r, statements } = reader();
    const found = await r.listPublished(tenant, { typeId: TYPE, cursor: cursorFor(NODE) });
    expect(found.ok).toBe(true);
    expect(statements[0]?.sql).toContain('null::text as anchor_value');
  });

  it('refuses a cursor whose node is not in the published rows', async () => {
    const { reader: r } = reader({ anchor: null });
    const found = await r.listPublished(tenant, { typeId: TYPE, cursor: cursorFor(NODE) });
    expect(found.ok ? null : found.error.issues).toEqual([
      { path: 'cursor', code: 'engine.cursor_invalid' },
    ]);
  });

  it('refuses a type the host does not know, before any read', async () => {
    const { reader: r, statements } = reader({}, typesOf(null));
    const found = await r.listPublished(tenant, { typeId: TYPE });
    expect(found.ok ? null : found.error.code).toBe('engine.not_found');
    expect(statements).toEqual([]);
  });

  it('treats a type with no definition as one with no fields', async () => {
    const { reader: r } = reader({}, typesOf({}, null));
    const found = await r.listPublished(tenant, { typeId: TYPE, filter: leaf(NAME, 'eq', 'x') });
    expect(found.ok ? null : found.error.issues).toEqual([
      { path: 'filter', code: 'filter.field_unknown' },
    ]);
  });

  it('refuses a field that is not filterable, as no scan exists here', async () => {
    const { reader: r, statements } = reader();
    const found = await r.listPublished(tenant, { typeId: TYPE, filter: leaf(NOTE, 'eq', 'x') });
    expect(found.ok ? null : found.error).toEqual({
      code: 'engine.validation_failed',
      retryable: false,
      issues: [{ path: 'filter', code: 'filter.not_declared' }],
    });
    expect(statements).toEqual([]);
  });

  it.each([
    ['a filter', { filter: leaf(WHEN, 'exists') }],
    ['a sort', { sort: { field: WHEN, direction: 'asc' } }],
  ])('refuses %s on a slot still filling', async (_name, over) => {
    const { reader: r, statements } = reader({}, typesOf(FILLING));
    const found = await r.listPublished(tenant, { typeId: TYPE, ...over } as never);
    expect(found.ok ? null : found.error.code).toBe('engine.filter_backfilling');
    expect(found.ok ? null : found.error.issues[0]?.fieldId).toBe(WHEN);
    expect(statements).toEqual([]);
  });

  it('refuses a sort on a field that is not sortable', async () => {
    const { reader: r } = reader();
    const found = await r.listPublished(tenant, {
      typeId: TYPE,
      sort: { field: NOTE, direction: 'asc' },
    });
    expect(found.ok ? null : found.error.issues[0]?.code).toBe('engine.sort_not_declared');
  });

  it.each([
    ['no project', { organizationId: tenant.organizationId }, { typeId: TYPE }],
    ['a type that is no uuid', tenant, { typeId: 'page' }],
    ['a limit over the page', tenant, { typeId: TYPE, limit: 101 }],
    ['an unknown key', tenant, { typeId: TYPE, draft: true }],
  ])('refuses %s before any read', async (_name, who, query) => {
    const definition = vi.fn(() => Promise.resolve(null));
    const { reader: r, statements } = reader({}, { definition });
    const found = await r.listPublished(who as TenantRef, query);
    expect(found.ok ? null : found.error.code).toBe('engine.validation_failed');
    expect(definition).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });

  it('throws on a stored slot map that names a column off the closed list', async () => {
    const { reader: r } = reader(
      {},
      typesOf({ [NAME]: { column: 'x; drop', state: 'ready' } } as never),
    );
    await expect(r.listPublished(tenant, { typeId: TYPE })).rejects.toThrow();
  });

  it('logs the type and the outcome', async () => {
    const logger = { info: vi.fn<EngineLogger['info']>(), warn: vi.fn<EngineLogger['warn']>() };
    await reader({}, typesOf(READY), logger).reader.listPublished(tenant, { typeId: TYPE });
    expect(logger.info).toHaveBeenCalledWith(
      'engine.published_list',
      expect.objectContaining({ type_id: TYPE, project_id: tenant.projectId }),
    );
  });
});

describe('storeTypes', () => {
  it('reads the definition through the app store, scoped to the tenant', async () => {
    const { store, statements } = scriptedStore(() => [
      { content_schema: SCHEMA, filter_slots: READY },
    ]);
    expect(await storeTypes(store).definition(tenant, TYPE)).toEqual({
      schema: SCHEMA,
      slots: READY,
    });
    expect(statements[0]?.sql).toContain('from "content_types"');
    expect(statements[0]?.parameters).toEqual([tenant.organizationId, tenant.projectId, TYPE]);
  });

  it('gives null for a type that is not there', async () => {
    const { store } = scriptedStore(() => []);
    expect(await storeTypes(store).definition(tenant, TYPE)).toBeNull();
  });
});

describe('publishedStore', () => {
  it('refuses anything but a database the published constructor opened', async () => {
    const store = publishedStore({} as PublishedDatabase);
    await expect(store.read(tenant, () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'DB_CONFIG_INVALID',
    });
  });
});

describe('cachedTypes', () => {
  const other: TenantRef = { ...tenant, projectId: projectId(id(30)) };
  const counting = (fail = false) => {
    const definition = vi.fn<PublishedTypes['definition']>(() =>
      fail ? Promise.reject(new Error('down')) : Promise.resolve({ schema: SCHEMA, slots: READY }),
    );
    return { definition };
  };

  it('reads once per tenant and type within the time to live', async () => {
    let clock = 0;
    const inner = counting();
    const types = cachedTypes(inner, { ttlMs: 100, now: () => clock });
    await types.definition(tenant, TYPE);
    await types.definition(tenant, TYPE);
    expect(inner.definition).toHaveBeenCalledTimes(1);
    // Both tenant ids are in the key, so another project never gets this one's definition.
    await types.definition(other, TYPE);
    expect(inner.definition).toHaveBeenCalledTimes(2);
    clock = 100;
    await types.definition(tenant, TYPE);
    expect(inner.definition).toHaveBeenCalledTimes(3);
  });

  it('shares one read between concurrent misses', async () => {
    const inner = counting();
    const types = cachedTypes(inner);
    await Promise.all([types.definition(tenant, TYPE), types.definition(tenant, TYPE)]);
    expect(inner.definition).toHaveBeenCalledTimes(1);
  });

  it('keeps at most maxEntries, dropping the least recently used', async () => {
    const inner = counting();
    const types = cachedTypes(inner, { maxEntries: 2 });
    await types.definition(tenant, id(41));
    await types.definition(tenant, id(42));
    await types.definition(tenant, id(41));
    await types.definition(tenant, id(43));
    expect(inner.definition).toHaveBeenCalledTimes(3);
    await types.definition(tenant, id(41));
    expect(inner.definition).toHaveBeenCalledTimes(3);
    await types.definition(tenant, id(42));
    expect(inner.definition).toHaveBeenCalledTimes(4);
  });

  it('does not keep a failed read', async () => {
    const inner = counting(true);
    const types = cachedTypes(inner);
    await expect(types.definition(tenant, TYPE)).rejects.toThrow('down');
    await expect(types.definition(tenant, TYPE)).rejects.toThrow('down');
    expect(inner.definition).toHaveBeenCalledTimes(2);
  });

  it.each([[{ maxEntries: 0 }], [{ maxEntries: 1.5 }], [{ ttlMs: -1 }], [{ ttlMs: Number.NaN }]])(
    'refuses %o',
    (options) => {
      expect(() => cachedTypes(counting(), options)).toThrow();
    },
  );
});
