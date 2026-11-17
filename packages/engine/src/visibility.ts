import { idOf, type TenantRef } from '@drefyn/tenancy';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { actorFields } from './actor.ts';
import { Refusal } from './errors.ts';
import { assertWritable } from './limits.ts';
import { moveChunkTerms } from './published-chunks.ts';
import {
  PUBLISH_ROLES,
  PUBLISH_SCOPES,
  STRICT_WORKFLOW,
  type PublishWorkflow,
} from './publish-rules.ts';
import type { EngineTx } from './store.ts';
import {
  effectiveVisibilitySql,
  lockTree,
  MAX_SUBTREE_ROWS,
  MAX_TREE_LEVELS,
  siteDefaultSql,
  visibilityOf,
} from './tree.ts';
import type { Actor, NodeId, VisibilityChange } from './types.ts';
import {
  VISIBILITIES,
  type EngineErrorCode,
  type NodeFamily,
  type Visibility,
} from './vocabulary.ts';
import { lockNode } from './write.ts';

export interface VisibilityFacts {
  readonly actor: Actor;
  readonly family: NodeFamily;
  readonly workflow: PublishWorkflow;
  // Something protected, or something that would follow an override, ends up public.
  readonly widens: boolean;
}

const holds = (roles: readonly string[], allowed: readonly string[]) =>
  roles.some((role) => allowed.includes(role));

// Pure, so every actor can be checked against a model. Null allows. Widening is publishing to the
// world, so only a person who may publish does it, whatever a key or a push may otherwise do.
// Tightening takes the same right to publish, from any actor that is not a job.
export function visibilityRefusal(facts: VisibilityFacts): EngineErrorCode | null {
  const { actor, workflow } = facts;
  if (facts.widens) {
    return actor.kind === 'user' && holds(actor.roles, PUBLISH_ROLES)
      ? null
      : 'engine.widen_requires_publish';
  }
  switch (actor.kind) {
    case 'user':
      return holds(actor.roles, PUBLISH_ROLES) ? null : 'engine.forbidden';
    case 'api_key':
      return workflow.apiKeysPublish && actor.scopes.includes(PUBLISH_SCOPES[facts.family])
        ? null
        : 'engine.forbidden';
    case 'git':
      return workflow.gitPublish ? null : 'engine.forbidden';
    case 'system':
      return 'engine.forbidden';
  }
}

// What publish writes. A node whose rows are protected stays protected even when the tree now
// says public: only setVisibility widens, so a publish by anyone, a restore of an old version
// included, can never be the step that opens a page.
export function heldVisibility(computed: Visibility, held: boolean): Visibility {
  return held ? 'protected' : computed;
}

const visibilityLock = (tenant: TenantRef) =>
  `engine.visibility:${tenant.organizationId}:${tenant.projectId}`;

// Publishes share it and a visibility change holds it alone, so a publish never computes from a
// tree a change is halfway through rewriting. Taken before the node's row lock, as the tree lock
// is, so neither order can deadlock.
export async function shareVisibility(tx: EngineTx, tenant: TenantRef): Promise<void> {
  await sql`select pg_advisory_xact_lock_shared(hashtextextended(${visibilityLock(tenant)}, 0))`.execute(
    tx,
  );
}

const publishFactsSchema = z.strictObject({
  visibility: z.enum(VISIBILITIES),
  held: z.boolean(),
});

export interface PublishVisibility {
  readonly visibility: Visibility;
  // The tree said public and the node's rows kept it protected.
  readonly held: boolean;
}

// In the publish transaction, under the node's lock. Anything unreadable throws, which fails the
// publish: no row is written with a guess.
export async function publishVisibility(
  tx: EngineTx,
  tenant: TenantRef,
  nodeId: NodeId,
): Promise<PublishVisibility> {
  const { rows } = await sql`
    select ${effectiveVisibilitySql(tenant, sql`${nodeId}::uuid`)} as visibility,
           exists (select 1 from app.published_versions p
                    where p.organization_id = ${tenant.organizationId}::uuid
                      and p.project_id = ${tenant.projectId}::uuid
                      and p.node_id = ${nodeId}::uuid
                      and p.visibility = 'protected') as held`.execute(tx);
  const parsed = publishFactsSchema.safeParse(rows[0]);
  if (!parsed.success) throw new Error('visibility unreadable');
  const visibility = heldVisibility(parsed.data.visibility, parsed.data.held);
  return { visibility, held: visibility !== parsed.data.visibility };
}

const flippedSchema = z.strictObject({
  nodes: z.number().int().nonnegative(),
  gone: z.array(z.string()),
  added: z.array(z.string()),
});

// Sets every published row of the target nodes to the target value: versions, filter rows and
// chunks, current or not, so a pinned old version is no more public than its page. Current chunks
// that flipped leave or enter the term tables in the same transaction. Answers how many nodes
// changed.
async function flip(tx: EngineTx, tenant: TenantRef, target: RawBuilder<unknown>): Promise<number> {
  const org = sql`${tenant.organizationId}::uuid`;
  const project = sql`${tenant.projectId}::uuid`;
  const { rows } = await sql`
    ${target},
    versions as (
      update app.published_versions p set visibility = t.vis
        from target t
       where p.organization_id = ${org} and p.project_id = ${project} and p.node_id = t.id
         and p.visibility <> t.vis
      returning p.node_id
    ),
    filters as (
      update app.published_filter_rows f set visibility = t.vis
        from target t
       where f.organization_id = ${org} and f.project_id = ${project} and f.node_id = t.id
         and f.visibility <> t.vis
      returning f.node_id
    ),
    chunks as (
      update app.published_chunks c set visibility = t.vis
        from target t
        join app.published_versions v
          on v.organization_id = ${org} and v.project_id = ${project} and v.node_id = t.id
       where c.organization_id = ${org} and c.project_id = ${project}
         and c.version_id = v.version_id and c.visibility <> t.vis
      returning c.id, c.is_current, c.visibility
    )
    select (select count(distinct node_id)
              from (select node_id from versions union all select node_id from filters) x)::int
             as nodes,
           coalesce((select array_agg(id::text order by id) from chunks
                      where is_current and visibility = 'protected'), '{}') as gone,
           coalesce((select array_agg(id::text order by id) from chunks
                      where is_current and visibility = 'public'), '{}') as added`.execute(tx);
  const parsed = flippedSchema.safeParse(rows[0]);
  if (!parsed.success) throw new Error('visibility flip unreadable');
  await moveChunkTerms(tx, tenant, { gone: parsed.data.gone, added: parsed.data.added });
  return parsed.data.nodes;
}

// One node, in the publish transaction, before its version row is written.
export const flipNode = (
  tx: EngineTx,
  tenant: TenantRef,
  nodeId: NodeId,
  visibility: Visibility,
): Promise<number> =>
  flip(tx, tenant, sql`with target (id, vis) as (select ${nodeId}::uuid, ${visibility}::text)`);

// Rows past the tree cap can predate it. A change reads this far down and refuses beyond it,
// since a branch it cannot see is a branch it would leave public.
const WALK_LEVELS = MAX_TREE_LEVELS * 2;

export type VisibilityScope =
  | { readonly kind: 'node'; readonly nodeId: NodeId; readonly override: Visibility | null }
  | { readonly kind: 'site'; readonly before: Visibility; readonly after: Visibility };

// Every node the change reaches with what it gets before and after. Each child keeps its own
// override and otherwise takes its parent's answer. Bounded in depth and in rows.
function walkSql(tenant: TenantRef, scope: VisibilityScope): RawBuilder<unknown> {
  const org = sql`${tenant.organizationId}::uuid`;
  const project = sql`${tenant.projectId}::uuid`;
  const seed =
    scope.kind === 'node'
      ? sql`
      select n.id, coalesce(n.visibility_override, i.vis), coalesce(${scope.override}::text, i.vis), 1
        from app.nodes n
        cross join (select ${effectiveVisibilitySql(
          tenant,
          sql`(select p.parent_id from app.nodes p
                where p.organization_id = ${org} and p.project_id = ${project}
                  and p.id = ${scope.nodeId}::uuid)`,
        )} as vis) i
       where n.organization_id = ${org} and n.project_id = ${project}
         and n.id = ${scope.nodeId}::uuid`
      : sql`
      select n.id, coalesce(n.visibility_override, ${scope.before}::text),
             coalesce(n.visibility_override, ${scope.after}::text), 1
        from app.nodes n
       where n.organization_id = ${org} and n.project_id = ${project} and n.parent_id is null`;
  return sql`
    with recursive down (id, before, after, level) as (
      ${seed}
      union all
      select c.id, coalesce(c.visibility_override, d.before),
             coalesce(c.visibility_override, d.after), d.level + 1
        from app.nodes c join down d on c.parent_id = d.id
       where c.organization_id = ${org} and c.project_id = ${project}
         and d.level <= ${WALK_LEVELS}
    ),
    walked as (select * from down limit ${MAX_SUBTREE_ROWS + 1})`;
}

const reachSchema = z.strictObject({
  nodes: z.number().int().nonnegative(),
  deep: z.boolean(),
  widens: z.boolean(),
  effective: z.enum(VISIBILITIES).nullable(),
});

interface Reach {
  readonly widens: boolean;
  readonly effective: Visibility | null;
}

async function reachOf(tx: EngineTx, tenant: TenantRef, scope: VisibilityScope): Promise<Reach> {
  const { rows } = await sql`
    ${walkSql(tenant, scope)}
    select count(*)::int as nodes,
           coalesce(bool_or(level > ${WALK_LEVELS}), false) as deep,
           coalesce(bool_or(after = 'public' and (before = 'protected' or exists (
             select 1 from app.published_versions p
              where p.organization_id = ${tenant.organizationId}::uuid
                and p.project_id = ${tenant.projectId}::uuid
                and p.node_id = walked.id and p.visibility = 'protected'))), false) as widens,
           min(after) filter (where level = 1) as effective
      from walked`.execute(tx);
  const parsed = reachSchema.safeParse(rows[0]);
  if (!parsed.success) throw new Error('visibility unreadable');
  const { nodes, deep, widens, effective } = parsed.data;
  if (deep || nodes > MAX_SUBTREE_ROWS) {
    throw new Refusal('engine.too_large', [{ path: 'nodeId', code: 'engine.too_large' }]);
  }
  return { widens, effective };
}

async function workflowOf(tx: EngineTx, tenant: TenantRef): Promise<PublishWorkflow> {
  const row = await tx
    .selectFrom('publish_workflows')
    .select(['approval_required', 'api_keys_publish', 'git_publish'])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .executeTakeFirst();
  if (row === undefined) return STRICT_WORKFLOW;
  return {
    approvalRequired: row.approval_required,
    apiKeysPublish: row.api_keys_publish,
    gitPublish: row.git_publish,
  };
}

async function siteDefaultOf(tx: EngineTx, tenant: TenantRef): Promise<Visibility> {
  const { rows } = await sql<{ visibility: unknown }>`
    select ${siteDefaultSql(tenant)} as visibility`.execute(tx);
  return visibilityOf(rows[0]?.visibility);
}

const actorIdOf = (actor: Actor) => {
  const fields = actorFields(actor);
  return typeof fields['actor_id'] === 'string' ? fields['actor_id'] : '';
};

interface LogRow {
  readonly node_id: string | null;
  readonly override: string | null;
  readonly effective: string;
  readonly widened: boolean;
  readonly nodes_changed: number;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly changed_at: Date;
}

const LOG_COLUMNS = [
  'node_id',
  'override',
  'effective',
  'widened',
  'nodes_changed',
  'actor_kind',
  'actor_id',
  'changed_at',
] as const;

const overrideOf = (value: string | null): Visibility | null =>
  value === null ? null : visibilityOf(value);

const changeOf = (row: LogRow): VisibilityChange => ({
  nodeId: row.node_id === null ? null : idOf('nod', row.node_id),
  override: overrideOf(row.override),
  effective: visibilityOf(row.effective),
  widened: row.widened,
  nodesChanged: row.nodes_changed,
  changedAt: row.changed_at,
});

export type VisibilityTarget =
  | { readonly kind: 'node'; readonly nodeId: NodeId; readonly override: Visibility | null }
  | { readonly kind: 'site'; readonly visibility: Visibility };

export interface VisibilityRequest {
  readonly scope: VisibilityTarget;
  readonly actor: Actor;
  readonly idempotencyKey: string;
}

const targetOf = (request: VisibilityRequest) =>
  request.scope.kind === 'node'
    ? { nodeId: request.scope.nodeId, override: request.scope.override }
    : { nodeId: null, override: request.scope.visibility };

// The same key and input answers what the first change answered, whatever happened since.
function replayed(request: VisibilityRequest, row: LogRow): VisibilityChange {
  const target = targetOf(request);
  const same =
    row.node_id === target.nodeId &&
    row.override === target.override &&
    row.actor_kind === request.actor.kind &&
    row.actor_id === actorIdOf(request.actor);
  if (!same) throw new Refusal('engine.idempotency_conflict');
  return changeOf(row);
}

async function writeTarget(
  tx: EngineTx,
  tenant: TenantRef,
  request: VisibilityRequest,
): Promise<void> {
  const { scope } = request;
  if (scope.kind === 'node') {
    await tx
      .updateTable('nodes')
      .set({ visibility_override: scope.override, updated_at: new Date() })
      .where('organization_id', '=', tenant.organizationId)
      .where('project_id', '=', tenant.projectId)
      .where('id', '=', scope.nodeId)
      .executeTakeFirstOrThrow();
    return;
  }
  await tx
    .insertInto('site_access')
    .values({
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      default_visibility: scope.visibility,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['organization_id', 'project_id'])
        .doUpdateSet({ default_visibility: scope.visibility, updated_at: new Date() }),
    )
    .execute();
}

// The whole change, in the caller's transaction. The tree lock stops a move reshaping what this
// reads; the visibility lock waits out publishes in flight and holds new ones until commit. Then
// the key, the node, the plan and the actor, all before any write.
export async function changeVisibility(
  tx: EngineTx,
  tenant: TenantRef,
  request: VisibilityRequest,
): Promise<VisibilityChange> {
  await lockTree(tx, tenant);
  await sql`select pg_advisory_xact_lock(hashtextextended(${visibilityLock(tenant)}, 0))`.execute(
    tx,
  );
  const prior = await tx
    .selectFrom('visibility_log')
    .select(LOG_COLUMNS)
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('idempotency_key', '=', request.idempotencyKey)
    .executeTakeFirst();
  if (prior !== undefined) return replayed(request, prior);

  const { scope } = request;
  // The site default is the docs site's own setting, so it is held to the page rules.
  const family =
    scope.kind === 'node' ? (await lockNode(tx, tenant, scope.nodeId)).family : 'docs_page';
  await assertWritable(tx, tenant, family);
  const walk: VisibilityScope =
    scope.kind === 'node'
      ? scope
      : { kind: 'site', before: await siteDefaultOf(tx, tenant), after: scope.visibility };
  const reach = await reachOf(tx, tenant, walk);
  const target = targetOf(request);
  // An override of public is a widening even where it changes nothing yet: it would hold the node
  // open when a person later shuts the branch above it.
  const widens = reach.widens || target.override === 'public';
  const refusal = visibilityRefusal({
    actor: request.actor,
    family,
    workflow: await workflowOf(tx, tenant),
    widens,
  });
  if (refusal !== null) throw new Refusal(refusal);

  await writeTarget(tx, tenant, request);
  const nodesChanged = await flip(
    tx,
    tenant,
    sql`${walkSql(tenant, walk)}, target (id, vis) as (select id, after from walked)`,
  );
  const effective = scope.kind === 'node' ? reach.effective : scope.visibility;
  const logged = await tx
    .insertInto('visibility_log')
    .values({
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      node_id: target.nodeId,
      override: target.override,
      effective: visibilityOf(effective),
      widened: widens,
      nodes_changed: nodesChanged,
      actor_kind: request.actor.kind,
      actor_id: actorIdOf(request.actor),
      idempotency_key: request.idempotencyKey,
    })
    .onConflict((conflict) =>
      conflict.columns(['organization_id', 'project_id', 'idempotency_key']).doNothing(),
    )
    .returning(LOG_COLUMNS)
    .executeTakeFirst();
  // Changes queue on the tree lock, so a second use of a key reads the first above. Should one
  // ever get here, it is refused rather than logged twice.
  if (logged === undefined) throw new Refusal('engine.idempotency_conflict');
  return changeOf(logged);
}
