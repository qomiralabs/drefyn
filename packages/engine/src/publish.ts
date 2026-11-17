import { DbError } from '@drefyn/db';
import type { Result } from '@drefyn/mdx';
import { idOf, type TenantRef, type UserId } from '@drefyn/tenancy';
import { sql, type SqlBool } from 'kysely';
import { actorFields } from './actor.ts';
import { Refusal, type EngineIssue } from './errors.ts';
import type { StoredFields } from './fields.ts';
import { parseSlotMap, slotRowOf, SLOT_COLUMNS } from './filter-slots.ts';
import { assertWritable } from './limits.ts';
import { publishRefusal, STRICT_WORKFLOW, type PublishWorkflow } from './publish-rules.ts';
import { writePublishedChunks, type ChunkCopy } from './published-chunks.ts';
import type { EngineTx } from './store.ts';
import type {
  Actor,
  ApprovalReceipt,
  ApproveInput,
  PublishInput,
  PublishReceipt,
} from './types.ts';
import type { EngineErrorCode, Origin, PublishErrorCode, Visibility } from './vocabulary.ts';
import {
  flipNode,
  publishVisibility,
  shareVisibility,
  type PublishVisibility,
} from './visibility.ts';
import { lockNode } from './write.ts';

export interface PublishError {
  readonly code: PublishErrorCode;
  readonly retryable: boolean;
  readonly issues: readonly EngineIssue[];
}

export type PublishResult<T> = Result<T, PublishError>;

export const publishError = (
  code: PublishErrorCode,
  issues: readonly EngineIssue[] = [],
): PublishError => ({ code, retryable: code === 'publish.unavailable', issues });

export const refusePublish = <T>(
  code: PublishErrorCode,
  issues?: readonly EngineIssue[],
): PublishResult<T> => ({ ok: false, error: publishError(code, issues) });

// Thrown inside the transaction, so a refusal found late rolls back every row before it.
export class PublishRefusal extends Error {
  readonly code: PublishErrorCode;

  constructor(code: PublishErrorCode) {
    super(code);
    this.name = 'PublishRefusal';
    this.code = code;
  }
}

// The shared helpers this path calls refuse in engine codes. These are the only ones they use.
const FROM_ENGINE: Partial<Readonly<Record<EngineErrorCode, PublishErrorCode>>> = {
  'engine.not_found': 'publish.not_found',
  'engine.read_only': 'publish.read_only',
};

const RETRYABLE_DB: ReadonlySet<string> = new Set(['DB_TIMEOUT', 'DB_UNAVAILABLE']);

// As settled, in publish codes. Anything unexpected stays a throw, after the rollback.
export async function publishSettled<T>(work: () => Promise<T>): Promise<PublishResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof PublishRefusal) return refusePublish(error.code);
    if (error instanceof Refusal) {
      const code = FROM_ENGINE[error.error.code];
      if (code !== undefined) return refusePublish(code);
    }
    if (error instanceof DbError && RETRYABLE_DB.has(error.code)) {
      return refusePublish('publish.unavailable');
    }
    throw error;
  }
}

const idAndKind = (actor: Actor) => {
  const fields = actorFields(actor);
  return { kind: actor.kind, id: typeof fields['actor_id'] === 'string' ? fields['actor_id'] : '' };
};

interface Facts {
  readonly origin: string;
  readonly fields: unknown;
  readonly filter_slots: unknown;
  readonly approval_required: boolean | null;
  readonly api_keys_publish: boolean | null;
  readonly git_publish: boolean | null;
  readonly approved: SqlBool;
  readonly current_version_id: string | null;
}

// One statement for everything the gate needs, under the node's lock. Every join names the
// tenant, so another tenant's version reads as absent and not only as hidden by policy.
async function readFacts(
  tx: EngineTx,
  tenant: TenantRef,
  input: PublishInput,
  typeId: string,
): Promise<Facts | undefined> {
  return tx
    .selectFrom('node_versions as v')
    .innerJoin('content_types as t', (join) =>
      join
        .on('t.organization_id', '=', tenant.organizationId)
        .on('t.project_id', '=', tenant.projectId)
        .on('t.id', '=', typeId),
    )
    .leftJoin('publish_workflows as w', (join) =>
      join
        .on('w.organization_id', '=', tenant.organizationId)
        .on('w.project_id', '=', tenant.projectId),
    )
    .select((eb) => [
      'v.origin',
      'v.fields',
      't.filter_slots',
      'w.approval_required',
      'w.api_keys_publish',
      'w.git_publish',
      eb
        .exists(
          eb
            .selectFrom('publish_approvals as a')
            .select('a.id')
            .where('a.organization_id', '=', tenant.organizationId)
            .where('a.project_id', '=', tenant.projectId)
            .where('a.node_id', '=', input.nodeId)
            .where('a.version_id', '=', input.versionId),
        )
        .as('approved'),
      eb
        .selectFrom('published_versions as p')
        .select('p.version_id')
        .where('p.organization_id', '=', tenant.organizationId)
        .where('p.project_id', '=', tenant.projectId)
        .where('p.node_id', '=', input.nodeId)
        .where('p.is_current', '=', true)
        .as('current_version_id'),
    ])
    .where('v.organization_id', '=', tenant.organizationId)
    .where('v.project_id', '=', tenant.projectId)
    .where('v.node_id', '=', input.nodeId)
    .where('v.id', '=', input.versionId)
    .executeTakeFirst();
}

const workflowOf = (facts: Facts): PublishWorkflow => ({
  approvalRequired: facts.approval_required ?? STRICT_WORKFLOW.approvalRequired,
  apiKeysPublish: facts.api_keys_publish ?? STRICT_WORKFLOW.apiKeysPublish,
  gitPublish: facts.git_publish ?? STRICT_WORKFLOW.gitPublish,
});

interface LogRow {
  readonly node_id: string;
  readonly version_id: string;
  readonly expected_head_version_id: string;
  readonly previous_version_id: string | null;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly render_policy_version: number;
  readonly published_at: Date;
}

const receiptOf = (row: LogRow, visibility: Visibility): PublishReceipt => ({
  nodeId: idOf('nod', row.node_id),
  versionId: idOf('ver', row.version_id),
  previousVersionId: row.previous_version_id === null ? null : idOf('ver', row.previous_version_id),
  renderPolicyVersion: row.render_policy_version,
  visibility,
  publishedAt: row.published_at,
});

// What the version's row says now, which a later visibility change may have moved. A row that
// is gone or unreadable answers protected: the receipt must never claim more than is true.
async function visibilityNow(tx: EngineTx, tenant: TenantRef, row: LogRow): Promise<Visibility> {
  const found = await tx
    .selectFrom('published_versions')
    .select('visibility')
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('node_id', '=', row.node_id)
    .where('version_id', '=', row.version_id)
    .executeTakeFirst();
  return found?.visibility === 'public' ? 'public' : 'protected';
}

// The same request again gets the receipt it had, whatever has changed since.
async function replayed(
  tx: EngineTx,
  tenant: TenantRef,
  input: PublishInput,
  row: LogRow,
): Promise<PublishReceipt> {
  const actor = idAndKind(input.actor);
  const same =
    row.node_id === input.nodeId &&
    row.version_id === input.versionId &&
    row.expected_head_version_id === input.expectedHeadVersionId &&
    row.actor_kind === actor.kind &&
    row.actor_id === actor.id;
  if (!same) throw new PublishRefusal('publish.idempotency_conflict');
  return receiptOf(row, await visibilityNow(tx, tenant, row));
}

// Every column, so a value the version dropped cannot stay behind in its slot.
async function writeFilterRow(
  tx: EngineTx,
  tenant: TenantRef,
  typeId: string,
  input: PublishInput,
  facts: Facts,
  visibility: Visibility,
): Promise<void> {
  const row = slotRowOf(parseSlotMap(facts.filter_slots), facts.fields as StoredFields);
  const values = SLOT_COLUMNS.map((column) => {
    const value = row[column];
    if (column.startsWith('t')) return sql`${value}::text`;
    if (column.startsWith('l')) return sql`${value}::text[]`;
    if (column.startsWith('i')) return sql`${value}::bigint`;
    return sql`${value}::timestamptz`;
  });
  const columns = SLOT_COLUMNS.map((column) => sql.ref(column));
  const assignments = SLOT_COLUMNS.map(
    (column) => sql`${sql.ref(column)} = ${sql.ref(`excluded.${column}`)}`,
  );
  await sql`
    insert into app.published_filter_rows
      (organization_id, project_id, type_id, node_id, visibility, ${sql.join(columns)})
    values (${tenant.organizationId}::uuid, ${tenant.projectId}::uuid, ${typeId}::uuid,
            ${input.nodeId}::uuid, ${visibility}, ${sql.join(values)})
    on conflict on constraint published_filter_rows_pkey do update
      set visibility = excluded.visibility, ${sql.join(assignments)}`.execute(tx);
}

// The copy is made in the database, so the content never travels through this process.
async function writeVersion(
  tx: EngineTx,
  tenant: TenantRef,
  typeId: string,
  input: PublishInput,
  renderPolicyVersion: number,
  visibility: Visibility,
): Promise<void> {
  await tx
    .updateTable('published_versions')
    .set({ is_current: false })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('node_id', '=', input.nodeId)
    .where('is_current', '=', true)
    .execute();
  // A version published before comes back as current, under the policy it renders with now.
  await sql`
    insert into app.published_versions (organization_id, project_id, node_id, version_id,
        type_id, content, fields, is_current, render_policy_version, visibility)
    select v.organization_id, v.project_id, v.node_id, v.id, ${typeId}::uuid, v.content,
        v.fields, true, ${renderPolicyVersion}::integer, ${visibility}
      from app.node_versions v
     where v.organization_id = ${tenant.organizationId}::uuid
       and v.project_id = ${tenant.projectId}::uuid
       and v.node_id = ${input.nodeId}::uuid
       and v.id = ${input.versionId}::uuid
    on conflict on constraint published_versions_version_key do update
      set is_current = true, render_policy_version = excluded.render_policy_version,
          visibility = excluded.visibility, published_at = now()`.execute(tx);
}

export interface ChunkCopyOptions {
  // Off writes no chunk or term row, so publish behaves as it did before retrieval.
  readonly copyChunks: boolean;
  // Told the counts once the copy is written, for the log line.
  readonly copied?: (copy: ChunkCopy) => void;
  // Told what the rows were given, for the log line.
  readonly resolved?: (visibility: PublishVisibility) => void;
}

// The whole publish, in the caller's transaction. Checks run before any write: the key, then
// the gate, then the head, then visibility. A refusal or a failed read at any point leaves
// nothing behind.
export async function publishVersion(
  tx: EngineTx,
  tenant: TenantRef,
  input: PublishInput,
  renderPolicyVersion: number,
  chunks: ChunkCopyOptions = { copyChunks: false },
): Promise<PublishReceipt> {
  await shareVisibility(tx, tenant);
  const node = await lockNode(tx, tenant, input.nodeId);
  const prior = await tx
    .selectFrom('publish_log')
    .select([
      'node_id',
      'version_id',
      'expected_head_version_id',
      'previous_version_id',
      'actor_kind',
      'actor_id',
      'render_policy_version',
      'published_at',
    ])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('idempotency_key', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (prior !== undefined) return replayed(tx, tenant, input, prior);

  const facts = await readFacts(tx, tenant, input, node.typeId);
  if (facts === undefined) throw new PublishRefusal('publish.not_found');
  const refusal = publishRefusal({
    actor: input.actor,
    family: node.family,
    origin: facts.origin as Origin,
    workflow: workflowOf(facts),
    approved: facts.approved === true,
  });
  if (refusal !== null) throw new PublishRefusal(refusal);
  if (node.headVersionId !== input.expectedHeadVersionId) {
    throw new PublishRefusal('publish.version_conflict');
  }
  await assertWritable(tx, tenant, node.family);
  const resolved = await publishVisibility(tx, tenant, input.nodeId);
  const { visibility } = resolved;

  const actor = idAndKind(input.actor);
  // The same key can race on another node, which holds a different lock. That request had
  // other input, so losing the race is a conflict, and the throw rolls back this one.
  const logged = await tx
    .insertInto('publish_log')
    .values({
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      node_id: input.nodeId,
      version_id: input.versionId,
      expected_head_version_id: input.expectedHeadVersionId,
      previous_version_id: facts.current_version_id,
      actor_kind: actor.kind,
      actor_id: actor.id,
      idempotency_key: input.idempotencyKey,
      render_policy_version: renderPolicyVersion,
    })
    .onConflict((conflict) =>
      conflict.columns(['organization_id', 'project_id', 'idempotency_key']).doNothing(),
    )
    .returning([
      'node_id',
      'version_id',
      'expected_head_version_id',
      'previous_version_id',
      'actor_kind',
      'actor_id',
      'render_policy_version',
      'published_at',
    ])
    .executeTakeFirst();
  if (logged === undefined) throw new PublishRefusal('publish.idempotency_conflict');

  // Rows the node already has follow first, chunks included, whether or not this publish copies
  // chunks: a row left from before must not stay more public than the page.
  await flipNode(tx, tenant, input.nodeId, visibility);
  await writeVersion(tx, tenant, node.typeId, input, renderPolicyVersion, visibility);
  await writeFilterRow(tx, tenant, node.typeId, input, facts, visibility);
  if (chunks.copyChunks) {
    // The same visibility as the version row, so a chunk is never more public than its page.
    const copy = await writePublishedChunks(tx, tenant, input.nodeId, {
      versionId: input.versionId,
      visibility,
    });
    chunks.copied?.(copy);
  }
  chunks.resolved?.(resolved);
  await tx
    .updateTable('nodes')
    .set({ lifecycle: 'published', published_version_id: input.versionId, updated_at: new Date() })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', input.nodeId)
    .executeTakeFirstOrThrow();
  return receiptOf(logged, visibility);
}

// The caller has checked the actor. Approving twice keeps the first approval's time.
export async function approveVersion(
  tx: EngineTx,
  tenant: TenantRef,
  input: ApproveInput,
  approverId: UserId,
): Promise<ApprovalReceipt> {
  const version = await tx
    .selectFrom('node_versions as v')
    .innerJoin('nodes as n', (join) =>
      join
        .onRef('n.organization_id', '=', 'v.organization_id')
        .onRef('n.project_id', '=', 'v.project_id')
        .onRef('n.id', '=', 'v.node_id'),
    )
    .select('v.id')
    .where('v.organization_id', '=', tenant.organizationId)
    .where('v.project_id', '=', tenant.projectId)
    .where('v.node_id', '=', input.nodeId)
    .where('v.id', '=', input.versionId)
    .where('n.deleted_at', 'is', null)
    .executeTakeFirst();
  if (version === undefined) throw new PublishRefusal('publish.not_found');
  await tx
    .insertInto('publish_approvals')
    .values({
      organization_id: tenant.organizationId,
      project_id: tenant.projectId,
      node_id: input.nodeId,
      version_id: input.versionId,
      approver_id: approverId,
    })
    .onConflict((conflict) =>
      conflict.columns(['organization_id', 'project_id', 'version_id', 'approver_id']).doNothing(),
    )
    .execute();
  const row = await tx
    .selectFrom('publish_approvals')
    .select('approved_at')
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('version_id', '=', input.versionId)
    .where('approver_id', '=', approverId)
    .executeTakeFirstOrThrow();
  return {
    nodeId: input.nodeId,
    versionId: input.versionId,
    approverId,
    approvedAt: row.approved_at,
  };
}
