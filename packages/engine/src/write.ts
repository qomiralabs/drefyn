import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TenantRef } from '@drefyn/tenancy';
import { idOf } from '@drefyn/tenancy';
import { sql } from 'kysely';
import type { Chunk } from './chunk.ts';
import { Refusal } from './errors.ts';
import { canonicalFields, type StoredFields } from './fields.ts';
import { parseSlotMap, slotRowOf, SLOT_COLUMNS, type SlotMap } from './filter-slots.ts';
import type { NodeFamily, Origin } from './vocabulary.ts';
import { assertWritable } from './limits.ts';
import { storedSchema } from './query.ts';
import type { EngineTx } from './store.ts';
import type { Actor, NodeId, VersionId, VersionRef } from './types.ts';

export interface LockedNode {
  readonly id: NodeId;
  readonly family: NodeFamily;
  readonly typeId: string;
  readonly headVersionId: VersionId | null;
  readonly headFields: StoredFields;
}

export interface NewVersion {
  // Text, as jsonb reads it: a rollback passes stored bytes on untouched.
  readonly json: string;
  readonly sha256: Buffer;
  readonly astVersion: number;
  // From the version brought back on a rollback, else the type's current one.
  readonly schemaVersion?: number;
  readonly origin: Origin;
  readonly actor: Actor;
  readonly idempotencyKey: string;
  readonly expectedHeadVersionId: VersionId | null;
  // Only called once the version is certain to be written, so a replay or a conflict costs no
  // chunking. Empty when chunks are off.
  readonly chunksOf: () => readonly Chunk[];
  // What a client sent, held to the type's definition under the lock, where that is read.
  readonly rawFields?: Readonly<Record<string, unknown>> | undefined;
  // Values already in history, for a rollback. They passed that check when first saved.
  readonly storedFields?: StoredFields;
  readonly maxFieldsBytes: number;
}

const OUTBOX_EMBED_CHUNKS = 'embed_chunks';

// A second copy of a whole tree on every save. Studio list scans read content straight off the
// node, which is what the copy is for. Pages filter through filter rows and are read by key.
const headCopyOf = (node: LockedNode, json: string) => (node.family === 'docs_page' ? null : json);

// A page of bare headings gives a row per heading, up to about 25,000, and one statement can
// bind 65,535 values. Batches keep that page legal and leave a normal page one statement.
const CHUNK_ROWS_PER_INSERT = 500;

const tenantOf = (tenant: TenantRef) =>
  ({ organization_id: tenant.organizationId, project_id: tenant.projectId }) as const;

// Saves to one node queue here, which is what makes a sequence number safe to compute. It is
// alone in its statement: joined to the head version, a save that waited on this lock would
// recheck the join against its old snapshot and miss the head that was just written.
export async function lockNode(
  tx: EngineTx,
  tenant: TenantRef,
  nodeId: NodeId,
): Promise<LockedNode> {
  const row = await tx
    .selectFrom('nodes')
    .select(['id', 'family', 'type_id', 'head_version_id', 'head_fields'])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', nodeId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new Refusal('engine.not_found');
  return {
    id: nodeId,
    family: row.family as NodeFamily,
    typeId: row.type_id,
    headVersionId: row.head_version_id === null ? null : idOf('ver', row.head_version_id),
    headFields: row.head_fields as StoredFields,
  };
}

const refOf = (
  nodeId: NodeId,
  row: { id: string; seq: number; content_sha256: Buffer },
): VersionRef => ({
  nodeId,
  versionId: idOf('ver', row.id),
  seq: row.seq,
  contentSha256: row.content_sha256.toString('hex'),
});

interface StoredVersion {
  readonly id: string;
  readonly seq: number;
  readonly node_id: string;
  readonly parent_version_id: string | null;
  readonly origin: string;
  readonly actor: unknown;
  readonly content_sha256: Buffer;
  readonly fields: unknown;
}

// The same request again gets the version it made, whatever has happened to the head since.
function replayed(
  node: LockedNode,
  draft: NewVersion,
  row: StoredVersion,
  fields: StoredFields | null,
): VersionRef {
  const same =
    (fields === null || isDeepStrictEqual(row.fields, fields)) &&
    row.node_id === node.id &&
    row.parent_version_id === draft.expectedHeadVersionId &&
    row.origin === draft.origin &&
    row.content_sha256.equals(draft.sha256) &&
    isDeepStrictEqual(row.actor, draft.actor);
  if (!same) throw new Refusal('engine.idempotency_conflict');
  return refOf(node.id, row);
}

interface WriteRead {
  readonly replay: StoredVersion | null;
  readonly headSeq: number;
  readonly schemaVersion: number;
  readonly schema: unknown;
  readonly slots: unknown;
}

// One statement for all a write needs to know, as each one more is a round trip under the row
// lock. It starts from the type, which every node has, so there is always a row. Every join names
// the tenant: a key or a head from elsewhere must read as absent, not rely on policy alone.
async function readForWrite(
  tx: EngineTx,
  tenant: TenantRef,
  node: LockedNode,
  draft: NewVersion,
): Promise<WriteRead> {
  const row = await tx
    .selectFrom('content_types as t')
    .leftJoin('node_versions as h', (join) =>
      join
        .on('h.organization_id', '=', tenant.organizationId)
        .on('h.project_id', '=', tenant.projectId)
        .on('h.id', '=', node.headVersionId),
    )
    .leftJoin('node_versions as r', (join) =>
      join
        .on('r.organization_id', '=', tenant.organizationId)
        .on('r.project_id', '=', tenant.projectId)
        .on('r.idempotency_key', '=', draft.idempotencyKey),
    )
    .select([
      'h.seq as head_seq',
      't.current_schema_version as schema_version',
      't.content_schema',
      't.filter_slots',
      'r.id as replay_id',
      'r.seq as replay_seq',
      'r.node_id as replay_node_id',
      'r.parent_version_id as replay_parent_version_id',
      'r.origin as replay_origin',
      'r.actor as replay_actor',
      'r.content_sha256 as replay_content_sha256',
      'r.fields as replay_fields',
    ])
    .where('t.organization_id', '=', tenant.organizationId)
    .where('t.project_id', '=', tenant.projectId)
    .where('t.id', '=', node.typeId)
    .executeTakeFirstOrThrow();
  const replay =
    row.replay_id === null
      ? null
      : ({
          id: row.replay_id,
          seq: row.replay_seq,
          node_id: row.replay_node_id,
          parent_version_id: row.replay_parent_version_id,
          origin: row.replay_origin,
          actor: row.replay_actor,
          content_sha256: row.replay_content_sha256,
          fields: row.replay_fields,
        } as StoredVersion);
  return {
    replay,
    headSeq: row.head_seq ?? 0,
    schemaVersion: row.schema_version,
    schema: row.content_schema,
    slots: row.filter_slots,
  };
}

// Another node's save can take the same key between that read and the insert.
async function raceWinner(
  tx: EngineTx,
  tenant: TenantRef,
  node: LockedNode,
  draft: NewVersion,
  fields: StoredFields | null,
): Promise<VersionRef> {
  const row = await tx
    .selectFrom('node_versions')
    .select([
      'id',
      'seq',
      'node_id',
      'parent_version_id',
      'origin',
      'actor',
      'content_sha256',
      'fields',
    ])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('idempotency_key', '=', draft.idempotencyKey)
    .executeTakeFirst();
  if (row === undefined) throw new Refusal('engine.idempotency_conflict');
  return replayed(node, draft, row, fields);
}

// In the version's transaction, so no version commits without its chunks. Embeddings stay out:
// the row left here is all a later job needs, and a provider is never called under a lock.
async function writeChunks(
  tx: EngineTx,
  tenant: TenantRef,
  nodeId: NodeId,
  versionId: string,
  chunks: readonly Chunk[],
): Promise<void> {
  if (chunks.length === 0) return;
  const rowsAt = (from: number) =>
    chunks.slice(from, from + CHUNK_ROWS_PER_INSERT).map((chunk) => ({
      ...tenantOf(tenant),
      node_id: nodeId,
      version_id: versionId,
      ord: chunk.ord,
      block_path: chunk.blockPath,
      heading_path: [...chunk.headingPath],
      body: chunk.body,
      body_sha256: createHash('sha256').update(chunk.body).digest(),
    }));
  const last = Math.floor((chunks.length - 1) / CHUNK_ROWS_PER_INSERT) * CHUNK_ROWS_PER_INSERT;
  for (let from = 0; from < last; from += CHUNK_ROWS_PER_INSERT) {
    await tx.insertInto('chunks').values(rowsAt(from)).execute();
  }
  // With the last rows, so an ordinary page writes all of this in one round trip.
  await tx
    .with('written', (db) => db.insertInto('chunks').values(rowsAt(last)))
    .insertInto('engine_outbox')
    .values({
      ...tenantOf(tenant),
      node_id: nodeId,
      version_id: versionId,
      kind: OUTBOX_EMBED_CHUNKS,
    })
    .execute();
}

// The statement itself compares, so an unchanged row costs one round trip and no write. Most
// saves edit a body, and a write here would cost lists a heap fetch until the next vacuum.
async function writeSlots(
  tx: EngineTx,
  tenant: TenantRef,
  node: LockedNode,
  slots: SlotMap,
  fields: StoredFields,
): Promise<void> {
  const row = slotRowOf(slots, fields);
  const values = SLOT_COLUMNS.map((column) => {
    const value = row[column];
    const named = sql.ref(column);
    if (column.startsWith('t')) return sql`${value}::text as ${named}`;
    if (column.startsWith('l')) return sql`${value}::text[] as ${named}`;
    if (column.startsWith('i')) return sql`${value}::bigint as ${named}`;
    return sql`${value}::timestamptz as ${named}`;
  });
  const assignments = SLOT_COLUMNS.map(
    (column) => sql`${sql.ref(column)} = ${sql.ref(`v.${column}`)}`,
  );
  const current = SLOT_COLUMNS.map((column) => sql.ref(`f.${column}`));
  const next = SLOT_COLUMNS.map((column) => sql.ref(`v.${column}`));
  await sql`
    update app.node_filter_rows f set ${sql.join(assignments)}
    from (select ${sql.join(values)}) v
    where f.organization_id = ${tenant.organizationId as string}::uuid
      and f.project_id = ${tenant.projectId as string}::uuid
      and f.type_id = ${node.typeId}::uuid
      and f.node_id = ${node.id as string}::uuid
      and (${sql.join(current)}) is distinct from (${sql.join(next)})`.execute(tx);
}

function fieldsOfDraft(draft: NewVersion, stored: unknown): StoredFields | null {
  if (draft.storedFields !== undefined) return draft.storedFields;
  if (draft.rawFields === undefined) return null;
  const checked = canonicalFields(storedSchema(stored), draft.rawFields, draft.maxFieldsBytes);
  if (!checked.ok) throw new Refusal(checked.error.code, checked.error.issues);
  return checked.value;
}

// One way into history, for saves and rollbacks alike. The caller holds the node's lock. The
// key is read before the head is compared, or a retry of a save that landed would conflict with
// itself. Only a request that will write is held to the plan.
export async function appendVersion(
  tx: EngineTx,
  tenant: TenantRef,
  node: LockedNode,
  draft: NewVersion,
): Promise<VersionRef> {
  const known = await readForWrite(tx, tenant, node, draft);
  const fields = fieldsOfDraft(draft, known.schema);
  if (known.replay !== null) return replayed(node, draft, known.replay, fields);
  if (node.headVersionId !== draft.expectedHeadVersionId) {
    throw new Refusal('engine.version_conflict');
  }
  await assertWritable(tx, tenant, node.family);
  const seq = known.headSeq + 1;
  const inserted = await tx
    .insertInto('node_versions')
    .values({
      ...tenantOf(tenant),
      node_id: node.id,
      seq,
      parent_version_id: node.headVersionId,
      schema_version: draft.schemaVersion ?? known.schemaVersion,
      ast_version: draft.astVersion,
      origin: draft.origin,
      actor: JSON.stringify(draft.actor),
      content: draft.json,
      content_sha256: draft.sha256,
      idempotency_key: draft.idempotencyKey,
      fields: JSON.stringify(fields ?? node.headFields),
    })
    // The same key can race on another node, which holds a different lock. Doing nothing leaves
    // this transaction usable, and the next read sees the winner's row.
    .onConflict((conflict) =>
      conflict
        .columns(['organization_id', 'project_id', 'idempotency_key'])
        .where('idempotency_key', 'is not', null)
        .doNothing(),
    )
    .returning(['id', 'seq', 'content_sha256'])
    .executeTakeFirst();
  if (inserted === undefined) return raceWinner(tx, tenant, node, draft, fields);
  await tx
    .updateTable('nodes')
    .set({
      head_version_id: inserted.id,
      head_content: headCopyOf(node, draft.json),
      head_fields: JSON.stringify(fields ?? node.headFields),
      updated_at: new Date(),
    })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', node.id)
    .executeTakeFirstOrThrow();
  if (fields !== null) {
    const slots = parseSlotMap(known.slots);
    if (Object.keys(slots).length > 0) await writeSlots(tx, tenant, node, slots, fields);
  }
  await writeChunks(tx, tenant, node.id, inserted.id, draft.chunksOf());
  return refOf(node.id, inserted);
}
