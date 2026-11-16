import { withPublishedReader, type PublishedDatabase, type PublishedSchema } from '@drefyn/db';
import type { FieldDef, FieldId, FilterNode } from '@drefyn/schema';
import { checkFilter } from '@drefyn/schema';
import { idOf, type TenantRef } from '@drefyn/tenancy';
import { sql, type Transaction } from 'kysely';
import { compileFilter, operandOf, type CompileContext, type Raw } from './compile.ts';
import type { NodeContent } from './content.ts';
import { parsedOrRefused, settled, tenantFields } from './engine.ts';
import { Refusal, type EngineResult } from './errors.ts';
import type { StoredFields } from './fields.ts';
import { parseSlotMap, type SlotMap } from './filter-slots.ts';
import { publishedGetSchema, publishedQuerySchema } from './input.ts';
import { noopLogger, type EngineLogger, type LogFields } from './ports.ts';
import {
  badCursor,
  decodeCursor,
  emptySchema,
  encodeCursor,
  fieldsIn,
  filterRefusal,
  keyset,
  ordering,
  sortOf,
  storedSchema,
  type Position,
} from './query.ts';
import type { EngineStore } from './store.ts';
import type { NodeId, NodeQuery, SortDirection, VersionId } from './types.ts';

export type PublishedTx = Transaction<PublishedSchema>;

// Where public reads run. The only real one is publishedStore, which holds the public reader
// role; tests script one without a server.
export interface PublishedStore {
  read<T>(tenant: TenantRef, work: (tx: PublishedTx) => Promise<T>): Promise<T>;
}

export const publishedStore = (
  db: PublishedDatabase,
  options?: { readonly timeoutMs?: number },
): PublishedStore => ({
  read: (tenant, work) => withPublishedReader(db, tenant, work, options),
});

// A type's definition and slot map, as content_types stores them. The reader has no grant on
// that table, so the host reads them its own way. Both are parsed again here, since a slot
// column becomes an identifier.
export interface PublishedTypeDefinition {
  readonly schema: unknown;
  readonly slots: unknown;
}

export interface PublishedTypes {
  definition(tenant: TenantRef, typeId: string): Promise<PublishedTypeDefinition | null>;
}

// Definitions through the app role. A definition is no draft content, and a public path never
// holds the store: the host builds this and hands the reader only the result.
export const storeTypes = (store: EngineStore): PublishedTypes => ({
  definition: (tenant, typeId) =>
    store.tenant(tenant, async (tx) => {
      const row = await tx
        .selectFrom('content_types')
        .select(['content_schema', 'filter_slots'])
        .where('organization_id', '=', tenant.organizationId)
        .where('project_id', '=', tenant.projectId)
        .where('id', '=', typeId)
        .executeTakeFirst();
      return row === undefined ? null : { schema: row.content_schema, slots: row.filter_slots };
    }),
});

export interface TypeCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

interface CachedDefinition {
  readonly at: number;
  readonly value: Promise<PublishedTypeDefinition | null>;
}

// Public traffic is the most of any path, and without this every list would also take an app
// pool connection for a definition that changes a few times a day. Bounded, and short lived: a
// definition up to ttlMs old can only refuse a field just added or read a slot just retired,
// both on published rows, never a draft. Concurrent misses share one read.
export function cachedTypes(inner: PublishedTypes, options: TypeCacheOptions = {}): PublishedTypes {
  const maxEntries = options.maxEntries ?? 1000;
  const ttlMs = options.ttlMs ?? 10_000;
  const now = options.now ?? Date.now;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer');
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new Error('ttlMs must be a non negative integer');
  }
  const entries = new Map<string, CachedDefinition>();
  return {
    definition(tenant, typeId) {
      const key = `${tenant.organizationId}:${tenant.projectId}:${typeId}`;
      const at = now();
      const hit = entries.get(key);
      entries.delete(key);
      if (hit !== undefined && at - hit.at < ttlMs) {
        entries.set(key, hit);
        return hit.value;
      }
      const value = inner.definition(tenant, typeId);
      entries.set(key, { at, value });
      // A failed read is not kept, so the next list asks again.
      value.catch(() => {
        if (entries.get(key)?.value === value) entries.delete(key);
      });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      return value;
    },
  };
}

// A version a public caller asks for by name. Only a published one resolves.
export interface VersionPin {
  readonly versionId: VersionId;
}

export interface PublishedNode {
  readonly nodeId: NodeId;
  readonly typeId: string;
  readonly versionId: VersionId;
  readonly isCurrent: boolean;
  readonly content: NodeContent;
  readonly fields: StoredFields;
  readonly renderPolicyVersion: number;
  readonly publishedAt: Date;
}

export interface PublishedNodeSummary {
  readonly nodeId: NodeId;
  readonly typeId: string;
  readonly versionId: VersionId;
  readonly publishedAt: Date;
}

export type PublishedQuery = NodeQuery;

export interface PublishedPage {
  readonly items: readonly PublishedNodeSummary[];
  readonly nextCursor: string | null;
}

export interface PublishedReader {
  getPublished(
    tenant: TenantRef,
    nodeId: NodeId,
    pin?: VersionPin,
  ): Promise<EngineResult<PublishedNode>>;
  listPublished(tenant: TenantRef, query: PublishedQuery): Promise<EngineResult<PublishedPage>>;
}

export interface PublishedReaderDeps {
  readonly store: PublishedStore;
  readonly types: PublishedTypes;
  readonly logger?: EngineLogger;
}

const BACKFILLING_MESSAGE =
  'This field is still being prepared. Filtering on it works once that finishes.';

// Published filter rows are written at publish time, so a slot still filling may be empty on
// them. A public list has no scan to fall back on, and a partial answer would look complete.
const refuseUnready = (fieldIds: readonly string[]): Refusal =>
  new Refusal(
    'engine.filter_backfilling',
    fieldIds.map((fieldId) => ({
      path: 'filter',
      code: 'engine.filter_backfilling',
      fieldId,
      message: BACKFILLING_MESSAGE,
    })),
  );

interface TypePlan {
  readonly fields: ReadonlyMap<FieldId, FieldDef>;
  readonly slots: SlotMap;
  readonly filter: FilterNode | null;
  readonly sort: ReturnType<typeof sortOf>;
  readonly direction: SortDirection;
}

function planOf(
  definition: PublishedTypeDefinition,
  typeId: string,
  query: {
    readonly filter?: unknown;
    readonly sort?: { readonly field: string; readonly direction: SortDirection } | undefined;
  },
): TypePlan {
  const schema = storedSchema(definition.schema);
  const slots = parseSlotMap(definition.slots);
  const fields = new Map((schema?.fields ?? []).map((field) => [field.id, field]));
  let filter: FilterNode | null = null;
  if (query.filter !== undefined) {
    // No scan exists on this path, so an undeclared field is refused by the check itself.
    const checked = checkFilter(schema ?? emptySchema(typeId), query.filter, {
      itemCount: 1,
      undeclaredScanMaxItems: 0,
    });
    if (!checked.ok) throw filterRefusal(checked.error);
    filter = checked.value.filter;
  }
  const sort = sortOf(schema, slots, query.sort);
  const used = filter === null ? new Set<FieldId>() : fieldsIn(filter, new Set());
  if (sort !== null) used.add(sort.field.id);
  const unready = [...used].filter((id) => slots[id]?.state !== 'ready').sort();
  if (unready.length > 0) throw refuseUnready(unready);
  return { fields, slots, filter, sort, direction: sort?.direction ?? 'desc' };
}

const tenantClause = (tenant: TenantRef, typeId: string): Raw =>
  sql`f.organization_id = ${tenant.organizationId}::uuid
      and f.project_id = ${tenant.projectId}::uuid
      and f.type_id = ${typeId}::uuid`;

async function anchorOf(
  tx: PublishedTx,
  tenant: TenantRef,
  typeId: string,
  x: Raw | null,
  node: string,
): Promise<Position> {
  const { rows } = await sql<{ anchor_value: string | null }>`
    select ${x === null ? sql`null::text` : sql`to_jsonb(${x}) #>> '{}'`} as anchor_value
    from app.published_filter_rows f
    where ${tenantClause(tenant, typeId)} and f.node_id = ${node}::uuid`.execute(tx);
  const row = rows[0];
  if (row === undefined) throw badCursor();
  return { node, value: row.anchor_value };
}

async function currentOf(
  tx: PublishedTx,
  tenant: TenantRef,
  ids: readonly string[],
): Promise<readonly PublishedNodeSummary[]> {
  if (ids.length === 0) return [];
  const found = await tx
    .selectFrom('published_versions')
    .select(['node_id', 'type_id', 'version_id', 'published_at'])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('node_id', 'in', ids)
    .where('is_current', '=', true)
    .execute();
  const byId = new Map(found.map((row) => [row.node_id, row]));
  // A filter row with no current version is an unpublish caught midway; it is left out.
  return ids.flatMap((id): PublishedNodeSummary[] => {
    const row = byId.get(id);
    if (row === undefined) return [];
    return [
      {
        nodeId: idOf('nod', row.node_id),
        typeId: row.type_id,
        versionId: idOf('ver', row.version_id),
        publishedAt: row.published_at,
      },
    ];
  });
}

async function listPage(
  tx: PublishedTx,
  tenant: TenantRef,
  typeId: string,
  plan: TypePlan,
  limit: number,
  cursorText: string | undefined,
): Promise<PublishedPage> {
  const { filter, sort, direction } = plan;
  const context: CompileContext = { fields: plan.fields, slots: plan.slots, route: 'slots' };
  const x = sort === null ? null : operandOf(sort.field, context).expression;
  const cursor = decodeCursor(cursorText, sort, direction);
  const place = cursor === null ? null : await anchorOf(tx, tenant, typeId, x, cursor.n);
  const id = sql.ref('f.node_id');
  const predicate = filter === null ? sql`true` : compileFilter(filter, context);
  const { rows } = await sql<{ id: string }>`
    select ${id} as id
    from app.published_filter_rows f
    where ${tenantClause(tenant, typeId)}
      and ${predicate}
      and ${keyset(sort, x, id, place, direction)}
    order by ${ordering(x, id, direction)}
    limit ${limit + 1}`.execute(tx);
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    items: await currentOf(
      tx,
      tenant,
      shown.map((row) => row.id),
    ),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor({ s: sort?.field.id ?? null, d: direction, n: last.id })
        : null,
  };
}

export function createPublishedReader(deps: PublishedReaderDeps): PublishedReader {
  const { store, types } = deps;
  const logger = deps.logger ?? noopLogger;

  // One line per read, ids and codes only.
  const logged = async <T>(
    event: string,
    fields: LogFields,
    work: () => Promise<EngineResult<T>>,
  ): Promise<EngineResult<T>> => {
    const started = performance.now();
    const result = await work();
    const duration_ms = Math.round(performance.now() - started);
    if (result.ok) logger.info(event, { ...fields, duration_ms });
    else logger.info(`${event}.refused`, { ...fields, code: result.error.code, duration_ms });
    return result;
  };

  return {
    async getPublished(rawTenant, rawNodeId, rawPin) {
      const input = parsedOrRefused(publishedGetSchema, {
        tenant: rawTenant,
        nodeId: rawNodeId,
        ...(rawPin === undefined ? {} : { pin: rawPin }),
      });
      if (!input.ok) return input;
      const { tenant, nodeId, pin } = input.value;
      return logged(
        'engine.published_get',
        { ...tenantFields(tenant), node_id: nodeId, pinned: pin !== undefined },
        () =>
          settled(() =>
            store.read(tenant, async (tx) => {
              let found = tx
                .selectFrom('published_versions')
                .select([
                  'node_id',
                  'type_id',
                  'version_id',
                  'is_current',
                  'content',
                  'fields',
                  'render_policy_version',
                  'published_at',
                ])
                .where('organization_id', '=', tenant.organizationId)
                .where('project_id', '=', tenant.projectId)
                .where('node_id', '=', nodeId);
              found =
                pin === undefined
                  ? found.where('is_current', '=', true)
                  : found.where('version_id', '=', pin.versionId);
              const row = await found.executeTakeFirst();
              if (row === undefined) throw new Refusal('engine.not_found');
              return {
                nodeId: idOf('nod', row.node_id),
                typeId: row.type_id,
                versionId: idOf('ver', row.version_id),
                isCurrent: row.is_current,
                // Written only by publish, from a version save already checked.
                content: row.content as unknown as NodeContent,
                fields: row.fields as StoredFields,
                renderPolicyVersion: row.render_policy_version,
                publishedAt: row.published_at,
              };
            }),
          ),
      );
    },

    async listPublished(rawTenant, rawQuery) {
      const input = parsedOrRefused(publishedQuerySchema, { tenant: rawTenant, query: rawQuery });
      if (!input.ok) return input;
      const { tenant, query } = input.value;
      return logged(
        'engine.published_list',
        { ...tenantFields(tenant), type_id: query.typeId },
        () =>
          settled(async () => {
            const definition = await types.definition(tenant, query.typeId);
            if (definition === null) throw new Refusal('engine.not_found');
            const plan = planOf(definition, query.typeId, query);
            return store.read(tenant, (tx) =>
              listPage(tx, tenant, query.typeId, plan, query.limit, query.cursor),
            );
          }),
      );
    },
  };
}
