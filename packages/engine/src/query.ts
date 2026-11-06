import {
  checkFilter,
  parseContentSchema,
  parseUnits,
  type ContentSchema,
  type FieldDef,
  type FieldId,
  type FilterError,
  type FilterNode,
  type TypeId,
} from '@drefyn/schema';
import { idOf, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { z } from 'zod';
import { compileFilter, operandOf, type CompileContext, type Raw, type Route } from './compile.ts';
import type { EngineConfig } from './config.ts';
import { Refusal } from './errors.ts';
import { parseSlotMap, type SlotMap } from './filter-slots.ts';
import type { EngineTx } from './store.ts';
import type { NodePage, NodeSummary, SortDirection } from './types.ts';
import type { NodeFamily, NodeLifecycle } from './vocabulary.ts';

const NOT_DECLARED_MESSAGE = 'Declare this field as filterable to filter a type of this size.';
const BACKFILLING_MESSAGE =
  'This field is still being prepared. Filtering on it works once that finishes.';

export interface TypeRow {
  readonly schema: ContentSchema | null;
  readonly slots: SlotMap;
}

// Stored by declareSchema, so a failure here is damage and not a bad request.
export function storedSchema(stored: unknown): ContentSchema | null {
  if (stored === null) return null;
  const parsed = parseContentSchema(stored);
  if (!parsed.ok) throw new Error('a stored content schema does not parse');
  return parsed.value;
}

// A type nothing was declared on has no fields, so every field a filter names is unknown.
const emptySchema = (typeId: string): ContentSchema => ({
  typeId: typeId as TypeId,
  apiName: 'undeclared',
  version: 1,
  fields: [],
  deprecated: [],
  retired: [],
});

async function readType(tx: EngineTx, tenant: TenantRef, typeId: string): Promise<TypeRow> {
  const row = await tx
    .selectFrom('content_types')
    .select(['content_schema', 'filter_slots'])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', typeId)
    .executeTakeFirst();
  if (row === undefined) throw new Refusal('engine.not_found');
  return { schema: storedSchema(row.content_schema), slots: parseSlotMap(row.filter_slots) };
}

function filterRefusal(error: FilterError): Refusal {
  return new Refusal('engine.validation_failed', [
    { path: error.path === '' ? 'filter' : `filter.${error.path}`, code: error.code },
  ]);
}

function fieldsIn(node: FilterNode, into: Set<FieldId>): Set<FieldId> {
  if ('and' in node) node.and.forEach((child) => fieldsIn(child, into));
  else if ('or' in node) node.or.forEach((child) => fieldsIn(child, into));
  else if ('not' in node) fieldsIn(node.not, into);
  else into.add(node.field);
  return into;
}

interface Sort {
  readonly field: FieldDef;
  readonly direction: SortDirection;
}

function sortOf(
  schema: ContentSchema | null,
  slots: SlotMap,
  sort: { readonly field: string; readonly direction: SortDirection } | undefined,
): Sort | null {
  if (sort === undefined) return null;
  const field = schema?.fields.find((candidate) => candidate.id === sort.field);
  const entry = slots[sort.field];
  if (field?.sortable !== true || entry === undefined || entry.state === 'clearing') {
    throw new Refusal('engine.validation_failed', [
      { path: 'sort.field', code: 'engine.sort_not_declared', fieldId: sort.field },
    ]);
  }
  return { field, direction: sort.direction };
}

const cursorSchema = z.strictObject({
  s: z.string().nullable(),
  d: z.enum(['asc', 'desc']),
  v: z.string().nullable(),
  n: z.uuid(),
});
type Cursor = z.output<typeof cursorSchema>;

const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const badCursor = () =>
  new Refusal('engine.validation_failed', [{ path: 'cursor', code: 'engine.cursor_invalid' }]);

const instant = z.iso.datetime({ offset: true });

// A cursor comes back from a client, so its value is held to what the sort column can parse.
function valueFits(field: FieldDef | undefined, value: string): boolean {
  if (value.includes('\0') || !value.isWellFormed()) return false;
  switch (field?.kind) {
    case 'number':
    case 'boolean':
      return parseUnits(value, 0) !== null;
    case 'date':
      return instant.safeParse(value).success;
    default:
      return true;
  }
}

function decodeCursor(text: string | undefined, sort: Sort | null, direction: SortDirection) {
  if (text === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  const parsed = cursorSchema.safeParse(raw);
  if (!parsed.success) throw badCursor();
  const { s, d, v } = parsed.data;
  // A page of one order cannot continue another.
  if (s !== (sort?.field.id ?? null) || d !== direction) throw badCursor();
  if (v !== null && (sort === null || !valueFits(sort.field, v))) throw badCursor();
  return parsed.data;
}

const after = (a: Raw, b: Raw, direction: SortDirection): Raw =>
  direction === 'asc' ? sql`${a} > ${b}` : sql`${a} < ${b}`;

function sortValue(sort: Sort, value: string): Raw {
  switch (sort.field.kind) {
    case 'number':
    case 'boolean':
      return sql`${value}::bigint`;
    case 'date':
      return sql`${value}::timestamptz`;
    default:
      return sql`${value}::text`;
  }
}

// Nulls come last in both directions, which a row comparison cannot say.
function keyset(
  sort: Sort | null,
  x: Raw | null,
  id: Raw,
  cursor: Cursor | null,
  d: SortDirection,
) {
  if (cursor === null) return sql`true`;
  const position = sql`${cursor.n}::uuid`;
  if (sort === null || x === null) return after(id, position, d);
  if (cursor.v === null) return sql`(${x} is null and ${after(id, position, d)})`;
  const value = sortValue(sort, cursor.v);
  return sql`(${after(x, value, d)} or (${x} = ${value} and ${after(id, position, d)}) or ${x} is null)`;
}

const ordering = (sort: Raw | null, id: Raw, d: SortDirection): Raw => {
  const tail = d === 'asc' ? sql`${id} asc` : sql`${id} desc`;
  if (sort === null) return tail;
  return d === 'asc' ? sql`${sort} asc nulls last, ${tail}` : sql`${sort} desc nulls last, ${tail}`;
};

interface PageRow {
  readonly id: string;
  readonly sort_value: string | null;
}

// Filter rows carry no deleted flag. Nodes are only removed by taking their filter row with
// them, and the summary read below drops a deleted node in any case.
function fromClause(route: Route, tenant: TenantRef, typeId: string): Raw {
  const { organizationId, projectId } = tenant;
  return route === 'slots'
    ? sql`app.node_filter_rows f
          where f.organization_id = ${organizationId}::uuid
            and f.project_id = ${projectId}::uuid
            and f.type_id = ${typeId}::uuid`
    : sql`app.nodes n
          where n.organization_id = ${organizationId}::uuid
            and n.project_id = ${projectId}::uuid
            and n.type_id = ${typeId}::uuid
            and n.deleted_at is null`;
}

interface Plan {
  readonly filter: FilterNode | null;
  readonly sort: Sort | null;
  readonly direction: SortDirection;
  readonly cursor: Cursor | null;
  readonly limit: number;
  readonly context: CompileContext;
}

async function readPage(
  tx: EngineTx,
  tenant: TenantRef,
  typeId: string,
  plan: Plan,
): Promise<readonly PageRow[]> {
  const { filter, sort, direction, cursor, limit, context } = plan;
  const operand = sort === null ? null : operandOf(sort.field, context);
  const x = operand?.expression ?? null;
  const id = context.route === 'slots' ? sql.ref('f.node_id') : sql.ref('n.id');
  const predicate = filter === null ? sql`true` : compileFilter(filter, context);
  const { rows } = await sql<PageRow>`
    select ${id} as id, ${x === null ? sql`null::text` : sql`to_jsonb(${x}) #>> '{}'`} as sort_value
    from ${fromClause(context.route, tenant, typeId)}
      and ${predicate}
      and ${keyset(sort, x, id, cursor, direction)}
    order by ${ordering(x, id, direction)}
    limit ${limit + 1}`.execute(tx);
  return rows;
}

async function summaries(
  tx: EngineTx,
  tenant: TenantRef,
  rows: readonly PageRow[],
): Promise<readonly NodeSummary[]> {
  if (rows.length === 0) return [];
  const found = await tx
    .selectFrom('nodes')
    .select(['id', 'family', 'type_id', 'lifecycle', 'slug', 'head_version_id', 'updated_at'])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where(
      'id',
      'in',
      rows.map((row) => row.id),
    )
    .where('deleted_at', 'is', null)
    .execute();
  const byId = new Map(found.map((row) => [row.id, row]));
  return rows.flatMap((row): NodeSummary[] => {
    const node = byId.get(row.id);
    if (node === undefined) return [];
    return [
      {
        nodeId: idOf('nod', node.id),
        family: node.family as NodeFamily,
        typeId: node.type_id,
        lifecycle: node.lifecycle as NodeLifecycle,
        slug: node.slug,
        versionId: node.head_version_id === null ? null : idOf('ver', node.head_version_id),
        updatedAt: node.updated_at,
      },
    ];
  });
}

// Stops at the first row past the limit, so asking costs no more than the scan it may allow.
async function fitsScan(
  tx: EngineTx,
  tenant: TenantRef,
  typeId: string,
  max: number,
): Promise<boolean> {
  const { rows } = await sql<{ items: number }>`
    select count(*) as items from (
      select 1 from app.node_filter_rows f
      where f.organization_id = ${tenant.organizationId}::uuid
        and f.project_id = ${tenant.projectId}::uuid
        and f.type_id = ${typeId}::uuid
      limit ${max + 1}) type_items`.execute(tx);
  return (rows[0]?.items ?? 0) <= max;
}

const refuseScan = (undeclared: readonly FieldId[], filling: readonly FieldId[]): Refusal =>
  undeclared.length > 0
    ? new Refusal(
        'engine.filter_not_declared',
        undeclared.map((fieldId) => ({
          path: 'filter',
          code: 'engine.filter_not_declared',
          fieldId,
          message: NOT_DECLARED_MESSAGE,
        })),
      )
    : new Refusal(
        'engine.filter_backfilling',
        filling.map((fieldId) => ({
          path: 'filter',
          code: 'engine.filter_backfilling',
          fieldId,
          message: BACKFILLING_MESSAGE,
        })),
      );

export interface QueryArgs {
  readonly typeId: string;
  readonly filter?: unknown;
  readonly sort?: { readonly field: string; readonly direction: SortDirection } | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface QueryOutcome {
  readonly page: NodePage;
  readonly route: Route;
}

export async function runQuery(
  tx: EngineTx,
  tenant: TenantRef,
  args: QueryArgs,
  config: Pick<EngineConfig, 'undeclaredScanMaxItems'>,
): Promise<QueryOutcome> {
  const { typeId, limit } = args;
  const { schema, slots } = await readType(tx, tenant, typeId);
  const fields = new Map((schema?.fields ?? []).map((field) => [field.id, field]));

  // Scan permission is decided below, with a count that only runs if a scan is on the table.
  let filter: FilterNode | null = null;
  let undeclared: readonly FieldId[] = [];
  if (args.filter !== undefined) {
    const checked = checkFilter(schema ?? emptySchema(typeId), args.filter, {
      itemCount: 0,
      undeclaredScanMaxItems: config.undeclaredScanMaxItems,
    });
    if (!checked.ok) throw filterRefusal(checked.error);
    ({ filter, undeclared } = checked.value);
  }

  const sort = sortOf(schema, slots, args.sort);
  const direction: SortDirection = sort?.direction ?? 'desc';
  const used = filter === null ? new Set<FieldId>() : fieldsIn(filter, new Set());
  if (sort !== null) used.add(sort.field.id);
  const filling = [...used].filter((id) => slots[id]?.state === 'backfilling').sort();

  const route: Route = undeclared.length > 0 || filling.length > 0 ? 'scan' : 'slots';
  if (route === 'scan' && !(await fitsScan(tx, tenant, typeId, config.undeclaredScanMaxItems))) {
    throw refuseScan(undeclared, filling);
  }

  const context: CompileContext = { fields, slots, route };
  const cursor = decodeCursor(args.cursor, sort, direction);
  const rows = await readPage(tx, tenant, typeId, {
    filter,
    sort,
    direction,
    cursor,
    limit,
    context,
  });
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    route,
    page: {
      items: await summaries(tx, tenant, shown),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({
              s: sort?.field.id ?? null,
              d: direction,
              v: last.sort_value,
              n: last.id,
            })
          : null,
      backfilling: Object.entries(slots)
        .filter(([, entry]) => entry.state === 'backfilling')
        .map(([id]) => id)
        .sort(),
    },
  };
}
