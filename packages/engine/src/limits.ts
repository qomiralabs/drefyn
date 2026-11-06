import { checkLimit, type LimitKey, type Tier } from '@drefyn/entitlements';
import type { TenantRef } from '@drefyn/tenancy';
import { Refusal } from './errors.ts';
import type { NodeFamily } from './vocabulary.ts';
import type { EngineTx } from './store.ts';

// Families the plans count. An incident is not capped: a plan must never stop a team from
// telling people about an outage.
const LIMIT_OF_FAMILY: Partial<Readonly<Record<NodeFamily, LimitKey>>> = {
  docs_page: 'docs.pages',
  studio_item: 'studio.items',
  status_component: 'status.components',
};

interface PlanState {
  readonly tier: Tier;
  readonly readOnly: boolean;
  readonly nodes: number;
}

async function planState(tx: EngineTx, tenant: TenantRef, family: NodeFamily): Promise<PlanState> {
  const row = await tx
    .selectFrom('organizations as o')
    .innerJoin('projects as p', (join) =>
      join.onRef('p.organization_id', '=', 'o.organization_id').on('p.id', '=', tenant.projectId),
    )
    .leftJoin('organization_node_counts as c', (join) =>
      join.onRef('c.organization_id', '=', 'o.organization_id').on('c.family', '=', family),
    )
    .select([
      'o.plan_tier',
      'o.read_only_since as organization_read_only',
      'p.read_only_since as project_read_only',
      'c.nodes',
    ])
    .where('o.organization_id', '=', tenant.organizationId)
    .executeTakeFirst();
  // A tenant with no organization row has nothing to write to.
  if (row === undefined) throw new Refusal('engine.not_found');
  return {
    tier: row.plan_tier as Tier,
    readOnly: row.organization_read_only !== null || row.project_read_only !== null,
    nodes: row.nodes ?? 0,
  };
}

const isOver = (state: PlanState, key: LimitKey | undefined, usage: number) =>
  key !== undefined && checkLimit(state.tier, key, usage).status !== 'allowed';

// Reads and writes differ here on purpose: an organization over its limit after a downgrade
// keeps every row, and only loses the right to change them.
export async function assertWritable(
  tx: EngineTx,
  tenant: TenantRef,
  family: NodeFamily,
): Promise<void> {
  const state = await planState(tx, tenant, family);
  if (state.readOnly || isOver(state, LIMIT_OF_FAMILY[family], state.nodes)) {
    throw new Refusal('engine.read_only');
  }
}

// Takes the count's row lock, held to commit, so two creates at the limit cannot both pass. A
// refusal rolls the increment back with everything else.
export async function reserveNode(
  tx: EngineTx,
  tenant: TenantRef,
  family: NodeFamily,
): Promise<void> {
  const key = LIMIT_OF_FAMILY[family];
  const state = await planState(tx, tenant, family);
  if (state.readOnly) throw new Refusal('engine.read_only');
  if (key === undefined) return;
  const counted = await tx
    .insertInto('organization_node_counts')
    .values({ organization_id: tenant.organizationId, family, nodes: 1 })
    .onConflict((conflict) =>
      conflict
        .columns(['organization_id', 'family'])
        .doUpdateSet((update) => ({ nodes: update.eb('organization_node_counts.nodes', '+', 1) })),
    )
    .returning('nodes')
    .executeTakeFirstOrThrow();
  if (!isOver(state, key, counted.nodes)) return;
  throw new Refusal(
    isOver(state, key, counted.nodes - 1) ? 'engine.read_only' : 'engine.limit_reached',
  );
}
