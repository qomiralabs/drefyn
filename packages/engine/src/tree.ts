import type { TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { Refusal } from './errors.ts';
import { assertWritable } from './limits.ts';
import { MAX_ORDER_KEY_CHARS, orderKeyBetween } from './order-key.ts';
import type { EngineTx } from './store.ts';
import type { NodeId } from './types.ts';
import { lockNode } from './write.ts';

// A root is level 1. The same bound the parser puts on a page's own nesting, and far past any
// sidebar a person could read, so honest trees never meet it. Rows already deeper stay readable
// and saveable: the cap only stops a tree getting deeper.
export const MAX_TREE_LEVELS = 64;

// How much of a moved subtree one move may read while everyone behind it waits.
export const MAX_SUBTREE_ROWS = 50_000;

// A waiter sits on a pooled connection, so this has to stay well under the pool's 2 s wait.
export const TREE_LOCK_WAIT_MS = 1000;

// Everything that picks a place in a tree queues here. A row lock could not do it: two moves that
// form a cycle touch different rows, and each sees a valid tree until the other commits. It is
// alone in its statement so the reads after it see what the holder before it committed. The wait
// stays set for the rest of the transaction on purpose: a holder stuck on a row lock stalls the
// whole queue. Nothing takes this while holding a node's row lock, so a save, which holds that
// one, cannot deadlock with a move.
export async function lockTree(tx: EngineTx, tenant: TenantRef): Promise<void> {
  const name = `engine.tree:${tenant.organizationId}:${tenant.projectId}`;
  await sql`set local lock_timeout = ${sql.raw(String(TREE_LOCK_WAIT_MS))}`.execute(tx);
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

interface Climb {
  // Counts the start, and stops one past the cap, so anything deeper reads as over it.
  readonly levels: number;
  readonly gone: boolean;
  // Whether the sought node is on the way up.
  readonly holds: boolean;
}

// One row back, never the chain. The level limit also ends the walk on a cycle already in the
// data, and every level names the tenant, so the walk stops at the edge of the project even if a
// key were ever wrong.
async function climb(
  tx: EngineTx,
  tenant: TenantRef,
  from: NodeId,
  sought: NodeId | null,
): Promise<Climb> {
  const { organizationId, projectId } = tenant;
  const { rows } = await sql<Climb>`
    with recursive chain (id, parent_id, deleted_at, level) as (
      select id, parent_id, deleted_at, 1 from app.nodes
      where organization_id = ${organizationId}::uuid and project_id = ${projectId}::uuid
        and id = ${from}::uuid
      union all
      select n.id, n.parent_id, n.deleted_at, chain.level + 1 from app.nodes n
        join chain on n.id = chain.parent_id
      where n.organization_id = ${organizationId}::uuid and n.project_id = ${projectId}::uuid
        and chain.level <= ${MAX_TREE_LEVELS}
    )
    select count(*)::int as levels,
           coalesce(bool_or(deleted_at is not null), false) as gone,
           coalesce(bool_or(id = ${sought}::uuid), false) as holds
    from chain`.execute(tx);
  return rows[0] ?? { levels: 0, gone: false, holds: false };
}

// Reads no further than the room it has plus one level, and no more than the row budget, so a
// wide subtree costs a fixed amount however large it is.
async function subtreeOf(
  tx: EngineTx,
  tenant: TenantRef,
  nodeId: NodeId,
  room: number,
): Promise<{ readonly height: number; readonly rows: number }> {
  const { organizationId, projectId } = tenant;
  const { rows } = await sql<{ height: number; rows: number }>`
    with recursive below (id, level) as (
      select id, 1 from app.nodes
      where organization_id = ${organizationId}::uuid and project_id = ${projectId}::uuid
        and id = ${nodeId}::uuid
      union all
      select n.id, below.level + 1 from app.nodes n
        join below on n.parent_id = below.id
      where n.organization_id = ${organizationId}::uuid and n.project_id = ${projectId}::uuid
        and below.level <= ${room}
    ), seen as (select level from below limit ${MAX_SUBTREE_ROWS})
    select coalesce(max(level), 0)::int as height, count(*)::int as rows from seen`.execute(tx);
  return rows[0] ?? { height: 0, rows: 0 };
}

const tooDeep = () =>
  new Refusal('engine.validation_failed', [{ path: 'parentId', code: 'engine.tree_too_deep' }]);

// The caller holds the tree lock, or a create could land under a branch a move just took deep.
export async function assertRoomUnder(
  tx: EngineTx,
  tenant: TenantRef,
  parentId: NodeId,
): Promise<void> {
  const parent = await climb(tx, tenant, parentId, null);
  // A row under a deleted one cannot be seen, so it does not exist for this caller, as for a move.
  if (parent.levels === 0 || parent.gone) throw new Refusal('engine.not_found');
  if (parent.levels >= MAX_TREE_LEVELS) throw tooDeep();
}

// A cycle can only close with the node on the way up from its new parent. A move that goes no
// deeper cannot break the cap, and is how a tree already past it gets back under, so only a move
// down reads the subtree. The node's own walk comes in from the caller, sought with this parent.
async function assertParentFits(
  tx: EngineTx,
  tenant: TenantRef,
  nodeId: NodeId,
  parentId: NodeId,
  node: Climb,
): Promise<void> {
  const parent = await climb(tx, tenant, parentId, nodeId);
  // A parent inside a deleted branch cannot be seen, so it does not exist for this caller.
  if (parent.levels === 0 || parent.gone) throw new Refusal('engine.not_found');
  if (parent.holds) {
    throw new Refusal('engine.validation_failed', [{ path: 'parentId', code: 'engine.cycle' }]);
  }
  if (node.holds || parent.levels < node.levels) return;
  const room = MAX_TREE_LEVELS - parent.levels;
  if (room <= 0) throw tooDeep();
  const subtree = await subtreeOf(tx, tenant, nodeId, room);
  if (subtree.height > room) throw tooDeep();
  // Stopped early, so the height above proves nothing. Refusing is the only safe answer.
  if (subtree.rows >= MAX_SUBTREE_ROWS) {
    throw new Refusal('engine.too_large', [{ path: 'nodeId', code: 'engine.too_large' }]);
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
  const place = await climb(tx, tenant, move.nodeId, move.parentId);
  // Deleted with its branch, so it does not exist for this caller either. Letting it out would
  // leave a restore with a hole in the tree. The walk is capped, so a row more than 64 levels
  // under the deleted one still moves; only rows from before the cap can sit that deep.
  if (place.gone) throw new Refusal('engine.not_found');
  await assertWritable(tx, tenant, node.family);
  if (move.parentId !== null) {
    await assertParentFits(tx, tenant, move.nodeId, move.parentId, place);
  }
  const orderKey = await keyForMove(tx, tenant, move);
  await tx
    .updateTable('nodes')
    .set({ parent_id: move.parentId, order_key: orderKey, updated_at: new Date() })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', move.nodeId)
    .executeTakeFirstOrThrow();
}
