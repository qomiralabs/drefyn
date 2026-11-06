import { DbError } from '@drefyn/db';
import { idOf, type TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import type { z } from 'zod';
import { chunkNode, type Chunk, type ChunkOptions } from './chunk.ts';
import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from './config.ts';
import type { NodeContent } from './content.ts';
import { Refusal, engineError, refuse, type EngineResult } from './errors.ts';
import type { NodeFamily, NodeLifecycle, Origin } from './vocabulary.ts';
import {
  createNodeSchema,
  issuesOf,
  pageSchema,
  readSchema,
  rollbackSchema,
  saveDraftSchema,
} from './input.ts';
import { reserveNode } from './limits.ts';
import {
  noopLogger,
  noopTracer,
  type EngineFlags,
  type EngineLogger,
  type EngineTracer,
  type LogFields,
} from './ports.ts';
import type { EngineStore, EngineTx } from './store.ts';
import type {
  CreateNodeInput,
  NodeHead,
  NodeId,
  NodeRef,
  Page,
  PageArgs,
  RollbackInput,
  SaveDraftInput,
  VersionRef,
  VersionSummary,
} from './types.ts';
import { verifyContent, type ParsePolicy, type VerifyDeps } from './verify.ts';
import { appendVersion, lockNode } from './write.ts';

export interface EngineDeps {
  readonly store: EngineStore;
  readonly parse: VerifyDeps['parse'];
  readonly parsePolicy: ParsePolicy;
  readonly flags: EngineFlags;
  readonly config?: EngineConfig;
  readonly logger?: EngineLogger;
  readonly tracer?: EngineTracer;
}

export interface Engine {
  createNode(input: CreateNodeInput): Promise<EngineResult<NodeRef>>;
  saveDraft(input: SaveDraftInput): Promise<EngineResult<VersionRef>>;
  rollback(input: RollbackInput): Promise<EngineResult<VersionRef>>;
  getHead(tenant: TenantRef, nodeId: NodeId): Promise<EngineResult<NodeHead>>;
  listVersions(
    tenant: TenantRef,
    nodeId: NodeId,
    page: PageArgs,
  ): Promise<EngineResult<Page<VersionSummary>>>;
}

const FLAG_UNREAD = [{ path: 'flags', code: 'engine.flag_unavailable' }];

const RETRYABLE_DB: ReadonlySet<string> = new Set(['DB_TIMEOUT', 'DB_UNAVAILABLE']);

// A refusal becomes a result, and a busy database a retryable one. Anything else is a bug and
// stays a throw, after the store has rolled the transaction back.
async function settled<T>(work: () => Promise<T>): Promise<EngineResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.error };
    if (error instanceof DbError && RETRYABLE_DB.has(error.code)) {
      return refuse('engine.unavailable');
    }
    throw error;
  }
}

function parsedOrRefused<S extends z.ZodType>(
  schema: S,
  value: unknown,
): EngineResult<z.output<S>> {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: engineError('engine.validation_failed', issuesOf(parsed.error)) };
}

const tenantFields = (tenant: TenantRef): LogFields => ({
  organization_id: tenant.organizationId,
  project_id: tenant.projectId,
});

async function assertTypeFits(tx: EngineTx, input: z.output<typeof createNodeSchema>) {
  const { tenant, typeId, family, parentId } = input;
  const type = await tx
    .selectFrom('content_types')
    .select('family')
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', typeId)
    .executeTakeFirst();
  if (type === undefined) throw new Refusal('engine.not_found');
  if (type.family !== family) {
    throw new Refusal('engine.validation_failed', [
      { path: 'family', code: 'engine.family_mismatch' },
    ]);
  }
  if (parentId === null || parentId === undefined) return;
  const parent = await tx
    .selectFrom('nodes')
    .select('id')
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', parentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (parent === undefined) throw new Refusal('engine.not_found');
}

export function createEngine(deps: EngineDeps): Engine {
  const { store, flags } = deps;
  const config = deps.config ?? DEFAULT_ENGINE_CONFIG;
  const logger = deps.logger ?? noopLogger;
  const tracer = deps.tracer ?? noopTracer;
  const verifyDeps: VerifyDeps = { ...deps, config, logger, tracer };
  const chunkOptions: ChunkOptions = {
    targetChars: config.chunkTargetChars,
    maxChars: config.chunkMaxChars,
  };

  const read = async (name: 'engine.writes' | 'engine.chunk_at_write', tenant: TenantRef) => {
    try {
      return await flags.evaluate(name, {
        organizationId: tenant.organizationId,
        projectId: tenant.projectId,
      });
    } catch {
      return { value: false, errorCode: 'FLAG_GENERAL' };
    }
  };
  // A failed read gives false here too, and off refuses, so this one fails closed by itself.
  const writesOn = async (tenant: TenantRef) => {
    const { value, errorCode } = await read('engine.writes', tenant);
    return value && errorCode === undefined;
  };
  // A failed read must not count as off: the version would commit with no chunks, and nothing
  // would ever notice. Null refuses the write, and the caller can try again.
  const chunkingOn = async (tenant: TenantRef): Promise<boolean | null> => {
    const name = 'engine.chunk_at_write';
    const { value, errorCode } = await read(name, tenant);
    if (errorCode === undefined) return value;
    logger.warn('engine.flag_read_failed', {
      ...tenantFields(tenant),
      flag: name,
      code: errorCode,
    });
    return null;
  };

  // Every write leaves one line: what happened, to which ids, and how long it took.
  const logged = async <T>(
    event: string,
    fields: LogFields,
    work: () => Promise<EngineResult<T>>,
    details: (value: T) => LogFields,
  ): Promise<EngineResult<T>> => {
    const started = performance.now();
    const result = await tracer.span(event, fields, work);
    const duration_ms = Math.round(performance.now() - started);
    if (result.ok) logger.info(event, { ...fields, ...details(result.value), duration_ms });
    else logger.info(`${event}.refused`, { ...fields, code: result.error.code, duration_ms });
    return result;
  };

  const versionFields = (value: VersionRef): LogFields => ({
    version_id: value.versionId,
    seq: value.seq,
    content_sha256: value.contentSha256,
  });

  return {
    async createNode(raw) {
      const input = parsedOrRefused(createNodeSchema, raw);
      if (!input.ok) return input;
      const { tenant, family, typeId, parentId, slug, orderKey } = input.value;
      if (!(await writesOn(tenant))) return refuse('engine.forbidden');
      return logged(
        'engine.create',
        { ...tenantFields(tenant), family },
        () =>
          settled(() =>
            store.tenant(tenant, async (tx) => {
              await assertTypeFits(tx, input.value);
              await reserveNode(tx, tenant, family);
              const row = await tx
                .insertInto('nodes')
                .values({
                  organization_id: tenant.organizationId,
                  project_id: tenant.projectId,
                  family,
                  type_id: typeId,
                  parent_id: parentId ?? null,
                  slug: slug ?? null,
                  order_key: orderKey,
                  lifecycle: 'draft',
                })
                .returning('id')
                .executeTakeFirstOrThrow();
              return { nodeId: idOf('nod', row.id), family, typeId };
            }),
          ),
        (value) => ({ node_id: value.nodeId }),
      );
    },

    async saveDraft(raw) {
      const input = parsedOrRefused(saveDraftSchema, raw);
      if (!input.ok) return input;
      const { tenant, nodeId, content, origin, actor } = input.value;
      if (!(await writesOn(tenant))) return refuse('engine.forbidden');
      const chunking = await chunkingOn(tenant);
      if (chunking === null) return refuse('engine.unavailable', FLAG_UNREAD);
      const fields = { ...tenantFields(tenant), node_id: nodeId };
      // Counted when written, so a replay does not report rows it never made.
      let written = 0;
      return logged(
        'engine.save',
        { ...fields, origin, actor_kind: actor.kind },
        async () => {
          const verified = await tracer.span('engine.save.verify', fields, () =>
            verifyContent(content, tenant, nodeId, verifyDeps),
          );
          if (!verified.ok) return verified;
          // Before the transaction, which should hold its connection for writes alone.
          const chunks: readonly Chunk[] = chunking
            ? await tracer.span('engine.save.chunk', fields, () =>
                Promise.resolve(chunkNode(verified.value.tree, chunkOptions)),
              )
            : [];
          return tracer.span('engine.save.write', fields, () =>
            settled(() =>
              store.tenant(tenant, async (tx) => {
                const node = await lockNode(tx, tenant, nodeId);
                return appendVersion(tx, tenant, node, {
                  ...verified.value,
                  origin,
                  actor,
                  idempotencyKey: input.value.idempotencyKey,
                  expectedHeadVersionId: input.value.expectedHeadVersionId,
                  chunksOf: () => {
                    written = chunks.length;
                    return chunks;
                  },
                });
              }),
            ),
          );
        },
        (value) => ({ ...versionFields(value), chunks: written }),
      );
    },

    async rollback(raw) {
      const input = parsedOrRefused(rollbackSchema, raw);
      if (!input.ok) return input;
      const { tenant, nodeId, toVersionId, actor } = input.value;
      if (!(await writesOn(tenant))) return refuse('engine.forbidden');
      const chunking = await chunkingOn(tenant);
      if (chunking === null) return refuse('engine.unavailable', FLAG_UNREAD);
      let written = 0;
      return logged(
        'engine.rollback',
        { ...tenantFields(tenant), node_id: nodeId, to_version_id: toVersionId },
        () =>
          settled(() =>
            store.tenant(tenant, async (tx) => {
              const node = await lockNode(tx, tenant, nodeId);
              const target = await tx
                .selectFrom('node_versions')
                .select([
                  sql<string>`content::text`.as('json'),
                  'content_sha256',
                  'ast_version',
                  'schema_version',
                  'origin',
                ])
                .where('organization_id', '=', tenant.organizationId)
                .where('project_id', '=', tenant.projectId)
                .where('node_id', '=', nodeId)
                .where('id', '=', toVersionId)
                .executeTakeFirst();
              if (target === undefined) throw new Refusal('engine.not_found');
              // The origin travels with the content: a rollback must not turn a model's draft
              // into a person's, as publishing treats the two differently.
              return appendVersion(tx, tenant, node, {
                json: target.json,
                sha256: target.content_sha256,
                astVersion: target.ast_version,
                schemaVersion: target.schema_version,
                origin: target.origin as Origin,
                actor,
                idempotencyKey: input.value.idempotencyKey,
                expectedHeadVersionId: input.value.expectedHeadVersionId,
                // Chunked again and not copied: the target may predate chunking, and its rows
                // belong to its own version.
                chunksOf: () => {
                  if (!chunking) return [];
                  const chunks = chunkNode(JSON.parse(target.json) as NodeContent, chunkOptions);
                  written = chunks.length;
                  return chunks;
                },
              });
            }),
          ),
        (value) => ({ ...versionFields(value), chunks: written }),
      );
    },

    async getHead(rawTenant, rawNode) {
      const input = parsedOrRefused(readSchema, { tenant: rawTenant, nodeId: rawNode });
      if (!input.ok) return input;
      const { tenant, nodeId } = input.value;
      return settled(() =>
        store.tenant(tenant, async (tx) => {
          const row = await tx
            .selectFrom('nodes as n')
            .leftJoin('node_versions as v', (join) =>
              join
                .onRef('v.organization_id', '=', 'n.organization_id')
                .onRef('v.project_id', '=', 'n.project_id')
                .onRef('v.id', '=', 'n.head_version_id'),
            )
            .select([
              'n.family',
              'n.type_id',
              'n.lifecycle',
              'n.head_version_id',
              'n.head_content',
              'v.seq',
              'v.ast_version',
            ])
            .where('n.organization_id', '=', tenant.organizationId)
            .where('n.project_id', '=', tenant.projectId)
            .where('n.id', '=', nodeId)
            .where('n.deleted_at', 'is', null)
            .executeTakeFirst();
          if (row === undefined) throw new Refusal('engine.not_found');
          return {
            nodeId,
            family: row.family as NodeFamily,
            typeId: row.type_id,
            lifecycle: row.lifecycle as NodeLifecycle,
            versionId: row.head_version_id === null ? null : idOf('ver', row.head_version_id),
            seq: row.seq,
            astVersion: row.ast_version,
            content: row.head_content as NodeContent | null,
          };
        }),
      );
    },

    async listVersions(rawTenant, rawNode, rawPage) {
      const input = parsedOrRefused(readSchema, { tenant: rawTenant, nodeId: rawNode });
      if (!input.ok) return input;
      const page = parsedOrRefused(pageSchema, rawPage);
      if (!page.ok) return page;
      const { tenant, nodeId } = input.value;
      const { limit, before } = page.value;
      return settled(() =>
        store.tenant(tenant, async (tx) => {
          const node = await tx
            .selectFrom('nodes')
            .select('id')
            .where('organization_id', '=', tenant.organizationId)
            .where('project_id', '=', tenant.projectId)
            .where('id', '=', nodeId)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
          if (node === undefined) throw new Refusal('engine.not_found');
          let query = tx
            .selectFrom('node_versions')
            .select([
              'id',
              'seq',
              'parent_version_id',
              'origin',
              'ast_version',
              'content_sha256',
              'created_at',
            ])
            .where('organization_id', '=', tenant.organizationId)
            .where('project_id', '=', tenant.projectId)
            .where('node_id', '=', nodeId);
          if (before !== undefined) query = query.where('seq', '<', before);
          const rows = await query
            .orderBy('seq', 'desc')
            .limit(limit + 1)
            .execute();
          const items = rows.slice(0, limit).map((row): VersionSummary => ({
            versionId: idOf('ver', row.id),
            seq: row.seq,
            parentVersionId:
              row.parent_version_id === null ? null : idOf('ver', row.parent_version_id),
            origin: row.origin as Origin,
            astVersion: row.ast_version,
            contentSha256: row.content_sha256.toString('hex'),
            createdAt: row.created_at,
          }));
          return { items, nextBefore: rows.length > limit ? (items.at(-1)?.seq ?? null) : null };
        }),
      );
    },
  };
}
