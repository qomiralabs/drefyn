import { DbError } from '@drefyn/db';
import type { FieldDef } from '@drefyn/schema';
import type { TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { setTimeout as pause } from 'node:timers/promises';
import { headOperand, type Raw } from './compile.ts';
import type { EngineResult } from './errors.ts';
import { parseSlotMap, type SlotColumn, type SlotMap } from './filter-slots.ts';
import { storedSchema } from './query.ts';
import type { EngineStore, EngineTx } from './store.ts';
import type { BackfillState } from './types.ts';

// Measured: 1,000 rows and 100 ms cost lists a p95 of 1.25 s and saves 600 ms; this costs 147 ms
// and 40 ms, for about 50 percent more wall time.
export const BACKFILL_BATCH = 250;
export const BACKFILL_PAUSE_MS = 200;

interface Job {
  readonly id: string;
  readonly type_id: string;
  readonly field_id: string;
  readonly slot_column: string;
  readonly action: string;
  readonly after_node_id: string | null;
  readonly started_at: Date | null;
}

async function nextJob(tx: EngineTx, tenant: TenantRef): Promise<Job | undefined> {
  return tx
    .selectFrom('filter_backfills')
    .select(['id', 'type_id', 'field_id', 'slot_column', 'action', 'after_node_id', 'started_at'])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('done_at', 'is', null)
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
}

// In batches and in id order, the same lock a save takes first. A save either committed before
// this and its value is read here, or it waits and writes after, so a stale value cannot land.
async function lockBatch(tx: EngineTx, tenant: TenantRef, job: Job): Promise<readonly string[]> {
  let query = tx
    .selectFrom('nodes')
    .select('id')
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('type_id', '=', job.type_id);
  if (job.after_node_id !== null) query = query.where('id', '>', job.after_node_id);
  const rows = await query.orderBy('id').limit(BACKFILL_BATCH).forUpdate().execute();
  return rows.map((row) => row.id);
}

function fillValue(field: FieldDef): Raw {
  const operand = headOperand(field);
  if (operand.shape !== 'json_list') return operand.expression;
  const list = operand.expression;
  return sql`case when ${list} is null then null
                  else array(select jsonb_array_elements_text(${list})) end`;
}

async function writeBatch(
  tx: EngineTx,
  tenant: TenantRef,
  job: Job,
  column: SlotColumn,
  field: FieldDef | undefined,
  ids: readonly string[],
): Promise<void> {
  const target = sql.ref(column);
  const value = field === undefined ? sql`null` : fillValue(field);
  // Unchanged rows stay as they are: every write here costs a list a heap fetch until vacuum.
  await sql`
    update app.node_filter_rows f set ${target} = ${value}
    from app.nodes n
    where n.organization_id = ${tenant.organizationId}::uuid
      and n.project_id = ${tenant.projectId}::uuid
      and n.id = any(${ids}::uuid[])
      and f.organization_id = n.organization_id
      and f.project_id = n.project_id
      and f.type_id = n.type_id
      and f.node_id = n.id
      and ${sql.ref(`f.${column}`)} is distinct from ${value}`.execute(tx);
}

// Only now does the field start using its slot, in one step with the end of the work.
async function finish(tx: EngineTx, tenant: TenantRef, job: Job, slots: SlotMap): Promise<void> {
  const next = Object.fromEntries(
    Object.entries(slots).flatMap(([id, entry]) => {
      if (id !== job.field_id) return [[id, entry]];
      return job.action === 'fill' ? [[id, { ...entry, state: 'ready' }]] : [];
    }),
  );
  await tx
    .updateTable('content_types')
    .set({ filter_slots: JSON.stringify(next) })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', job.type_id)
    .execute();
  await tx
    .updateTable('filter_backfills')
    .set({ done_at: new Date() })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', job.id)
    .execute();
}

async function runBatch(tx: EngineTx, tenant: TenantRef, job: Job): Promise<BackfillState> {
  // A declare holds this row and then wants the job row this transaction holds, so waiting here
  // could deadlock. It will be done in a moment, and the next turn can start.
  const type = await tx
    .selectFrom('content_types')
    .select(['content_schema', 'filter_slots'])
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', job.type_id)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (type === undefined) return 'waiting';
  if (job.started_at === null) {
    await tx
      .updateTable('filter_backfills')
      .set({ started_at: new Date() })
      .where('organization_id', '=', tenant.organizationId)
      .where('project_id', '=', tenant.projectId)
      .where('id', '=', job.id)
      .execute();
  }
  const slots = parseSlotMap(type.filter_slots);
  const column = slots[job.field_id]?.column ?? (job.slot_column as SlotColumn);
  const field =
    job.action === 'fill'
      ? storedSchema(type.content_schema)?.fields.find(({ id }) => id === job.field_id)
      : undefined;

  const ids = await lockBatch(tx, tenant, job);
  if (ids.length > 0) await writeBatch(tx, tenant, job, column, field, ids);
  if (ids.length < BACKFILL_BATCH) {
    await finish(tx, tenant, job, slots);
    return 'finished';
  }
  await tx
    .updateTable('filter_backfills')
    .set({ after_node_id: ids.at(-1) ?? null })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', job.id)
    .execute();
  return 'running';
}

// One batch, one transaction. A kill loses at most this batch, and the cursor is where the next
// run picks up. Another project's running job shows only as the unique index refusing this turn.
export async function backfillStep(store: EngineStore, tenant: TenantRef): Promise<BackfillState> {
  try {
    return await store.tenant(tenant, async (tx) => {
      const job = await nextJob(tx, tenant);
      if (job === undefined) return 'idle';
      return runBatch(tx, tenant, job);
    });
  } catch (error) {
    if (error instanceof DbError && error.code === 'DB_UNIQUE_VIOLATION') return 'waiting';
    throw error;
  }
}

export interface BackfillRunner {
  backfillFilters(tenant: TenantRef): Promise<EngineResult<BackfillState>>;
}

// Paced, so lists stay inside their budget while a type fills. Stops on idle, on waiting and on
// any refusal: a job runner calls this again, and nothing is lost by stopping.
export async function runFilterBackfill(
  engine: BackfillRunner,
  tenant: TenantRef,
  wait: (ms: number) => Promise<unknown> = pause,
): Promise<EngineResult<BackfillState>> {
  for (;;) {
    const step = await engine.backfillFilters(tenant);
    if (!step.ok || step.value === 'idle' || step.value === 'waiting') return step;
    await wait(BACKFILL_PAUSE_MS);
  }
}
