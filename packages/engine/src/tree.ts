import type { TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { Refusal } from './errors.ts';
import { assertWritable } from './limits.ts';
import { MAX_ORDER_KEY_CHARS, orderKeyBetween } from './order-key.ts';
import type { EngineTx } from './store.ts';
import type { NodeId } from './types.ts';
import { lockNode } from './write.ts';

// Everything that picks a place in a tree queues here. A row lock could not do it: two moves that
// form a cycle touch different rows, and each sees a valid tree until the other commits. It is
// alone in its statement so the reads after it see what the holder before it committed, and
// statement_timeout bounds the wait. Nothing takes this while holding a node's row lock, so a
// save, which holds that one, cannot deadlock with a move.
export async function lockTree(tx: EngineTx, tenant: TenantRef): Promise<void> {
  const name = `engine.tree:${tenant.organizationId}:${tenant.projectId}`;
  await sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`.execute(tx);
}

const siblingsOf = (tx: EngineTx, tenant: TenantRef, parentId: NodeId | null) => {
  const live = tx
    .selectFrom('nodes')
    .select(['id', 'order_key'])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('deleted_at', 'is', null);
  return parentId === null
    ? live.where('parent_id', 'is', null)
    : live.where('parent_id', '=', parentId);
};

function keyBetween(path: string, low: string | null, high: string | null): string {
  const key = orderKeyBetween(low, high);
  if (key === null) {
    throw new Refusal('engine.validation_failed', [{ path, code: 'engine.order_key_no_room' }]);
  }
  if (key.length > MAX_ORDER_KEY_CHARS) {
    throw new Refusal('engine.too_large', [{ path, code: 'engine.too_large' }]);
  }
  return key;
}

// The caller holds the tree lock.
export async function tailKey(
  tx: EngineTx,
  tenant: TenantRef,
  parentId: NodeId | null,
): Promise<string> {
  const last = await siblingsOf(tx, tenant, parentId)
    .orderBy('order_key', 'desc')
    .limit(1)
    .executeTakeFirst();
  return keyBetween('orderKey', last?.order_key ?? null, null);
}

// Refuses the move when the node is on the way up from the new parent, which is the only way a
// move can close a cycle. Union and not union all, so a cycle that is somehow in the data ends
// the walk and not the statement. Every level names the tenant, so the walk stops at the edge of
// the project even if a key were ever wrong.
async function assertParentFits(
  tx: EngineTx,
  tenant: TenantRef,
  nodeId: NodeId,
  parentId: NodeId,
): Promise<void> {
  const { organizationId, projectId } = tenant;
  const { rows } = await sql<{ id: string; deleted_at: Date | null }>`
    with recursive chain (id, parent_id, deleted_at) as (
      select id, parent_id, deleted_at from app.nodes
      where organization_id = ${organizationId}::uuid and project_id = ${projectId}::uuid
        and id = ${parentId}::uuid
      union
      select n.id, n.parent_id, n.deleted_at from app.nodes n
        join chain on n.id = chain.parent_id
      where n.organization_id = ${organizationId}::uuid and n.project_id = ${projectId}::uuid
    )
    select id, deleted_at from chain`.execute(tx);
  // A parent inside a deleted branch cannot be seen, so it does not exist for this caller.
  if (rows.length === 0 || rows.some((row) => row.deleted_at !== null)) {
    throw new Refusal('engine.not_found');
  }
  if (rows.some((row) => row.id === nodeId)) {
    throw new Refusal('engine.validation_failed', [{ path: 'parentId', code: 'engine.cycle' }]);
  }
}

export interface Move {
  readonly nodeId: NodeId;
  readonly parentId: NodeId | null;
  readonly afterId: NodeId | null;
}

// The anchor is read as a child of the named parent, so a parent and a sibling that do not belong
// together read as not found. Ties sort by id, so the next sibling is found the same way.
async function keyForMove(
  tx: EngineTx,
  tenant: TenantRef,
  { nodeId, parentId, afterId }: Move,
): Promise<string> {
  const siblings = siblingsOf(tx, tenant, parentId);
  const anchor =
    afterId === null ? undefined : await siblings.where('id', '=', afterId).executeTakeFirst();
  if (afterId !== null && anchor === undefined) throw new Refusal('engine.not_found');
  const others = siblings.where('id', '!=', nodeId);
  const after =
    anchor === undefined
      ? others
      : others.where(sql<boolean>`(order_key, id) > (${anchor.order_key}, ${anchor.id}::uuid)`);
  const next = await after.orderBy('order_key').orderBy('id').limit(1).executeTakeFirst();
  return keyBetween('afterId', anchor?.order_key ?? null, next?.order_key ?? null);
}

// One row, always. Children follow their parent without being touched, and nothing else in the
// node changes, so the version chain, the head and the filter row stay as they are.
export async function moveWithinTree(tx: EngineTx, tenant: TenantRef, move: Move): Promise<void> {
  await lockTree(tx, tenant);
  const node = await lockNode(tx, tenant, move.nodeId);
  await assertWritable(tx, tenant, node.family);
  if (move.parentId !== null) await assertParentFits(tx, tenant, move.nodeId, move.parentId);
  const orderKey = await keyForMove(tx, tenant, move);
  await tx
    .updateTable('nodes')
    .set({ parent_id: move.parentId, order_key: orderKey, updated_at: new Date() })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', move.nodeId)
    .executeTakeFirstOrThrow();
}
