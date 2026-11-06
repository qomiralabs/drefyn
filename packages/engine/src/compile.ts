import type { FieldDef, FieldId, FilterNode, FilterOp } from '@drefyn/schema';
import { sql, type RawBuilder } from 'kysely';
import { Refusal } from './errors.ts';
import { filterValue } from './fields.ts';
import type { SlotColumn, SlotMap } from './filter-slots.ts';

// Slots read the covering key, alias f. A scan reads the head copy on the node, alias n.
export type Route = 'slots' | 'scan';

export interface CompileContext {
  readonly fields: ReadonlyMap<FieldId, FieldDef>;
  readonly slots: SlotMap;
  readonly route: Route;
}

export type Raw = RawBuilder<unknown>;
type ValueType = 'text' | 'bigint' | 'time';

export interface Scalar {
  readonly shape: 'scalar';
  readonly type: ValueType;
  readonly expression: Raw;
}

interface SlotList {
  readonly shape: 'slot_list';
  readonly expression: Raw;
}

interface JsonList {
  readonly shape: 'json_list';
  readonly expression: Raw;
  readonly element: FieldDef;
}

export type Operand = Scalar | SlotList | JsonList;

// The value and every field id go in as parameters. Nothing a caller sends is ever part of the
// text: the only identifiers here come from the closed column list.
const scalarValue = (type: ValueType, value: string): Raw => {
  switch (type) {
    case 'text':
      return sql`${value}::text`;
    case 'bigint':
      return sql`${value}::bigint`;
    default:
      return sql`${value}::timestamptz`;
  }
};

const scalarValues = (type: ValueType, values: readonly string[]): Raw => {
  switch (type) {
    case 'text':
      return sql`${values}::text[]`;
    case 'bigint':
      return sql`${values}::bigint[]`;
    default:
      return sql`${values}::timestamptz[]`;
  }
};

function typeOf(field: FieldDef): ValueType {
  switch (field.kind) {
    case 'number':
    case 'boolean':
      return 'bigint';
    case 'date':
      return 'time';
    default:
      return 'text';
  }
}

const headValue = (id: FieldId): Raw => sql`n.head_fields ->> ${id as string}::text`;

export function headOperand(field: FieldDef): Operand {
  const isList = field.kind === 'list' || (field.kind === 'reference' && field.many);
  if (isList) {
    const element = field.kind === 'list' ? field.of : { ...field, many: false };
    return {
      shape: 'json_list',
      expression: sql`n.head_fields -> ${field.id as string}::text`,
      element,
    };
  }
  const type = typeOf(field);
  const value = headValue(field.id);
  switch (field.kind) {
    case 'number':
      return { shape: 'scalar', type, expression: sql`(${value})::bigint` };
    case 'boolean':
      return { shape: 'scalar', type, expression: sql`(${value})::boolean::int::bigint` };
    case 'date':
      return { shape: 'scalar', type, expression: sql`(${value})::timestamptz` };
    default:
      return { shape: 'scalar', type, expression: value };
  }
}

function slotOperand(field: FieldDef, column: SlotColumn): Operand {
  const expression = sql.ref(`f.${column}`);
  return column.startsWith('l')
    ? { shape: 'slot_list', expression }
    : { shape: 'scalar', type: typeOf(field), expression };
}

export function operandOf(field: FieldDef, context: CompileContext): Operand {
  if (context.route === 'scan') return headOperand(field);
  const entry = context.slots[field.id];
  if (entry?.state !== 'ready') throw new Error('a field with no ready slot took the slot route');
  return slotOperand(field, entry.column);
}

// checkFilter has seen the value, but an instant shifted past year 9999 only shows up here.
function parameterOf(field: FieldDef, value: unknown): string | boolean {
  const scalar = filterValue(field, value);
  if (scalar !== null) return scalar;
  throw new Refusal('engine.validation_failed', [{ path: 'filter', code: 'filter.value_invalid' }]);
}

function asParameter(field: FieldDef, value: unknown): string {
  const scalar = parameterOf(field, value);
  if (typeof scalar === 'boolean') return scalar ? '1' : '0';
  return scalar;
}

function scalarLeaf(field: FieldDef, operand: Scalar, op: FilterOp, value: unknown): Raw {
  const { type, expression: x } = operand;
  const one = (): Raw => scalarValue(type, asParameter(field, value));
  switch (op) {
    case 'eq':
      return sql`${x} = ${one()}`;
    case 'neq':
      return sql`${x} is distinct from ${one()}`;
    case 'in':
      return sql`${x} = any(${scalarValues(
        type,
        (value as readonly string[]).map((item) => asParameter(field, item)),
      )})`;
    case 'gt':
      return sql`${x} > ${one()}`;
    case 'gte':
      return sql`${x} >= ${one()}`;
    case 'lt':
      return sql`${x} < ${one()}`;
    case 'lte':
      return sql`${x} <= ${one()}`;
    case 'contains':
      // No pattern language: a % or _ a caller typed is only ever a character.
      return sql`strpos(lower(${x}), lower(${one()})) > 0`;
    default:
      return sql`${x} is not null`;
  }
}

function slotListLeaf(operand: SlotList, op: FilterOp, value: unknown): Raw {
  const x = operand.expression;
  const values = (Array.isArray(value) ? value : [value]) as readonly string[];
  switch (op) {
    case 'eq':
      return sql`${x} @> ${values}::text[]`;
    case 'neq':
      return sql`(${x} @> ${values}::text[]) is not true`;
    case 'in':
      return sql`${x} && ${values}::text[]`;
    default:
      return sql`${x} is not null`;
  }
}

function jsonListLeaf(operand: JsonList, op: FilterOp, value: unknown): Raw {
  const x = operand.expression;
  const has = (item: unknown): Raw =>
    sql`${x} @> ${JSON.stringify(parameterOf(operand.element, item))}::jsonb`;
  switch (op) {
    case 'eq':
      return has(value);
    case 'neq':
      return sql`(${has(value)}) is not true`;
    case 'in':
      return sql`(${sql.join((value as readonly unknown[]).map(has), sql` or `)})`;
    default:
      return sql`${x} is not null`;
  }
}

function compileLeaf(
  node: Extract<FilterNode, { readonly field: FieldId }>,
  context: CompileContext,
): Raw {
  const field = context.fields.get(node.field);
  if (field === undefined) throw new Error('a checked filter named an unknown field');
  const operand = operandOf(field, context);
  if (operand.shape === 'scalar') return scalarLeaf(field, operand, node.op, node.value);
  if (operand.shape === 'slot_list') return slotListLeaf(operand, node.op, node.value);
  return jsonListLeaf(operand, node.op, node.value);
}

// A missing value compares to null. and and or treat that as false already, so only not needs
// help: without the coalesce, not eq would drop the very rows it should keep and disagree with
// neq.
export function compileFilter(node: FilterNode, context: CompileContext): Raw {
  if ('and' in node) {
    return sql`(${sql.join(
      node.and.map((child) => compileFilter(child, context)),
      sql` and `,
    )})`;
  }
  if ('or' in node) {
    return sql`(${sql.join(
      node.or.map((child) => compileFilter(child, context)),
      sql` or `,
    )})`;
  }
  if ('not' in node) return sql`not coalesce(${compileFilter(node.not, context)}, false)`;
  return compileLeaf(node, context);
}
