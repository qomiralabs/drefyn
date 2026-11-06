import { isDeepStrictEqual } from 'node:util';
import type { TenantRef } from '@drefyn/tenancy';
import { idOf } from '@drefyn/tenancy';
import { Refusal } from './errors.ts';
import type { NodeFamily, Origin } from './vocabulary.ts';
import { assertWritable } from './limits.ts';
import type { EngineTx } from './store.ts';
import type { Actor, NodeId, VersionId, VersionRef } from './types.ts';

export interface LockedNode {
  readonly id: NodeId;
  readonly family: NodeFamily;
  readonly typeId: string;
  readonly headVersionId: VersionId | null;
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
}

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
    .select(['id', 'family', 'type_id', 'head_version_id'])
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

// The same request again gets the version it made, whatever has happened to the head since.
async function replay(
  tx: EngineTx,
  tenant: TenantRef,
  node: LockedNode,
  draft: NewVersion,
): Promise<VersionRef | null> {
  const row = await tx
    .selectFrom('node_versions')
    .select(['id', 'seq', 'node_id', 'parent_version_id', 'origin', 'actor', 'content_sha256'])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('idempotency_key', '=', draft.idempotencyKey)
    .executeTakeFirst();
  if (row === undefined) return null;
  const same =
    row.node_id === node.id &&
    row.parent_version_id === draft.expectedHeadVersionId &&
    row.origin === draft.origin &&
    row.content_sha256.equals(draft.sha256) &&
    isDeepStrictEqual(row.actor, draft.actor);
  if (!same) throw new Refusal('engine.idempotency_conflict');
  return refOf(node.id, row);
}

async function headSeq(tx: EngineTx, tenant: TenantRef, head: VersionId | null): Promise<number> {
  if (head === null) return 0;
  const row = await tx
    .selectFrom('node_versions')
    .select('seq')
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', head)
    .executeTakeFirstOrThrow();
  return row.seq;
}

async function schemaVersionOf(tx: EngineTx, tenant: TenantRef, typeId: string): Promise<number> {
  const row = await tx
    .selectFrom('content_types')
    .select('current_schema_version')
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', typeId)
    .executeTakeFirstOrThrow();
  return row.current_schema_version;
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
  const earlier = await replay(tx, tenant, node, draft);
  if (earlier !== null) return earlier;
  if (node.headVersionId !== draft.expectedHeadVersionId) {
    throw new Refusal('engine.version_conflict');
  }
  await assertWritable(tx, tenant, node.family);
  const seq = (await headSeq(tx, tenant, node.headVersionId)) + 1;
  const inserted = await tx
    .insertInto('node_versions')
    .values({
      ...tenantOf(tenant),
      node_id: node.id,
      seq,
      parent_version_id: node.headVersionId,
      schema_version: draft.schemaVersion ?? (await schemaVersionOf(tx, tenant, node.typeId)),
      ast_version: draft.astVersion,
      origin: draft.origin,
      actor: JSON.stringify(draft.actor),
      content: draft.json,
      content_sha256: draft.sha256,
      idempotency_key: draft.idempotencyKey,
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
  if (inserted === undefined) {
    const winner = await replay(tx, tenant, node, draft);
    if (winner === null) throw new Refusal('engine.idempotency_conflict');
    return winner;
  }
  await tx
    .updateTable('nodes')
    .set({ head_version_id: inserted.id, head_content: draft.json, updated_at: new Date() })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', node.id)
    .executeTakeFirstOrThrow();
  return refOf(node.id, inserted);
}
