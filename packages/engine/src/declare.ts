import { parseContentSchema, validateSchema, type FieldId, type TypeId } from '@drefyn/schema';
import type { TenantRef } from '@drefyn/tenancy';
import { sql } from 'kysely';
import { Refusal } from './errors.ts';
import { assignSlots, parseSlotMap, type SlotWork } from './filter-slots.ts';
import { storedSchema } from './query.ts';
import type { EngineTx } from './store.ts';
import type { DeclaredSchema } from './types.ts';

export interface DeclareArgs {
  readonly typeId: string;
  readonly schema: unknown;
  readonly confirmedRemovals?: readonly string[] | undefined;
}

const rowsOf = (
  tenant: TenantRef,
  typeId: string,
  work: readonly SlotWork[],
  action: 'fill' | 'clear',
) =>
  work.map(({ fieldId, column }) => ({
    organization_id: tenant.organizationId,
    project_id: tenant.projectId,
    type_id: typeId,
    field_id: fieldId,
    slot_column: column,
    action,
  }));

// The type's row lock orders this against another declare and a finishing backfill, either of
// which would otherwise write an older slot map over this one.
export async function declareSchema(
  tx: EngineTx,
  tenant: TenantRef,
  args: DeclareArgs,
): Promise<DeclaredSchema> {
  const { typeId } = args;
  const scope = (table: 'content_types' | 'node_filter_rows') =>
    tx
      .selectFrom(table)
      .where('organization_id', '=', tenant.organizationId)
      .where('project_id', '=', tenant.projectId);
  const row = await scope('content_types')
    .select(['content_schema', 'filter_slots'])
    .where('id', '=', typeId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new Refusal('engine.not_found');

  const parsed = parseContentSchema(args.schema);
  if (!parsed.ok) throw new Refusal('engine.validation_failed', parsed.error.issues);
  const next = parsed.value;
  if (next.typeId !== typeId) {
    throw new Refusal('engine.validation_failed', [
      { path: 'schema.typeId', code: 'engine.type_mismatch' },
    ]);
  }
  const types = await scope('content_types').select('id').execute();
  const checked = validateSchema(next, storedSchema(row.content_schema), {
    knownTypes: new Set(types.map((type) => type.id as TypeId)),
    confirmedRemovals: (args.confirmedRemovals ?? []) as readonly FieldId[],
  });
  if (!checked.ok) throw new Refusal('engine.validation_failed', checked.error.issues);

  const item = await scope('node_filter_rows')
    .select('node_id')
    .where('type_id', '=', typeId)
    .limit(1)
    .executeTakeFirst();
  const plan = assignSlots(next, parseSlotMap(row.filter_slots), item !== undefined);
  if (!plan.ok) {
    const { code, fieldId } = plan.error;
    throw new Refusal('engine.validation_failed', [
      { path: 'schema.fields', code, ...(fieldId === undefined ? {} : { fieldId }) },
    ]);
  }
  const { slots, fills, clears } = plan.value;

  await tx
    .updateTable('content_types')
    .set({
      content_schema: JSON.stringify(next),
      filter_slots: JSON.stringify(slots),
      current_schema_version: next.version,
      updated_at: new Date(),
    })
    .where('organization_id', '=', tenant.organizationId)
    .where('project_id', '=', tenant.projectId)
    .where('id', '=', typeId)
    .execute();

  // A fill for a field that is now going away has nothing left to do.
  if (clears.length > 0) {
    await sql`
      update app.filter_backfills set done_at = now()
      where organization_id = ${tenant.organizationId}::uuid
        and project_id = ${tenant.projectId}::uuid
        and type_id = ${typeId}::uuid
        and action = 'fill'
        and done_at is null
        and field_id = any(${clears.map(({ fieldId }) => fieldId as string)}::uuid[])`.execute(tx);
  }
  const queued = [
    ...rowsOf(tenant, typeId, clears, 'clear'),
    ...rowsOf(tenant, typeId, fills, 'fill'),
  ];
  if (queued.length > 0) await tx.insertInto('filter_backfills').values(queued).execute();
  return { typeId, version: next.version, backfills: queued.length };
}
