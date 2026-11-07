import {
  FILTER_SLOTS,
  slotClassOf,
  type ContentSchema,
  type FieldDef,
  type FieldId,
} from '@drefyn/schema';
import { z } from 'zod';
import type { StoredFields, StoredValue } from './fields.ts';

const TEXT_COLUMNS = ['t1', 't2', 't3', 't4', 't5'] as const;
const LIST_COLUMNS = ['l1', 'l2', 'l3', 'l4', 'l5'] as const;
const INTEGER_COLUMNS = ['i1', 'i2', 'i3', 'i4', 'i5'] as const;
const TIME_COLUMNS = ['d1', 'd2'] as const;

// The only names that ever reach SQL as identifiers.
export const SLOT_COLUMNS = Object.freeze([
  ...TEXT_COLUMNS,
  ...LIST_COLUMNS,
  ...INTEGER_COLUMNS,
  ...TIME_COLUMNS,
] as const);

export type SlotColumn = (typeof SLOT_COLUMNS)[number];
export type SlotState = 'ready' | 'backfilling' | 'clearing';

export interface SlotEntry {
  readonly column: SlotColumn;
  readonly state: SlotState;
}

export type SlotMap = Readonly<Record<string, SlotEntry>>;
export type SlotRow = Readonly<Record<SlotColumn, string | readonly string[] | null>>;

const slotMapSchema = z.record(
  z.uuid(),
  z.strictObject({
    column: z.enum(SLOT_COLUMNS),
    state: z.enum(['ready', 'backfilling', 'clearing']),
  }),
);

// Stored JSON, but a column from here becomes an identifier, so it is held to the closed list.
export const parseSlotMap = (stored: unknown): SlotMap => slotMapSchema.parse(stored);

// The btree limit on one index tuple. Past it a save would fail with a server error, so a
// definition that could reach it is refused while a person is still looking at it.
const MAX_INDEX_TUPLE_BYTES = 2704;
const TUPLE_HEADER_BYTES = 8 + 32;
const KEY_BYTES = 4 * 16;
const FIXED_COLUMN_BYTES = 8 * (FILTER_SLOTS.integer + FILTER_SLOTS.time);
const VARLENA_BYTES = 4;
const ARRAY_HEADER_BYTES = 24;
const UUID_TEXT_BYTES = 36;

const aligned = (bytes: number) => Math.ceil(bytes / 4) * 4;

function widestBytes(field: FieldDef): number {
  switch (field.kind) {
    case 'text':
      return aligned(field.maxLength + VARLENA_BYTES);
    case 'reference':
      return aligned(UUID_TEXT_BYTES + VARLENA_BYTES);
    case 'list':
      return (
        ARRAY_HEADER_BYTES +
        field.maxItems *
          (field.of.kind === 'text' ? aligned(field.of.maxLength + VARLENA_BYTES) : 0)
      );
    default:
      return 0;
  }
}

export interface SlotWork {
  readonly fieldId: FieldId;
  readonly column: SlotColumn;
}

export interface SlotPlan {
  readonly slots: SlotMap;
  readonly fills: readonly SlotWork[];
  readonly clears: readonly SlotWork[];
}

export interface SlotRefusal {
  readonly code: 'engine.filter_slot_busy' | 'engine.filter_row_too_wide';
  readonly fieldId?: FieldId;
}

export type SlotResult = { ok: true; value: SlotPlan } | { ok: false; error: SlotRefusal };

const numberOf = (column: SlotColumn) => column.slice(1);

// A text slot's two columns are one slot, so either one being held takes the number.
function freeColumn(field: FieldDef, held: ReadonlySet<SlotColumn>): SlotColumn | null {
  const slotClass = slotClassOf(field);
  if (slotClass === 'integer') {
    return INTEGER_COLUMNS.find((column) => !held.has(column)) ?? null;
  }
  if (slotClass === 'time') return TIME_COLUMNS.find((column) => !held.has(column)) ?? null;
  const numbers = new Set(
    [...held].filter((column) => /^[tl]/.test(column)).map((column) => numberOf(column)),
  );
  const columns = field.kind === 'list' ? LIST_COLUMNS : TEXT_COLUMNS;
  return columns.find((column) => !numbers.has(numberOf(column))) ?? null;
}

// Pure. A field keeps its slot for life: only an empty type or a finished clear frees one.
export function assignSlots(schema: ContentSchema, prior: SlotMap, hasItems: boolean): SlotResult {
  const declared = schema.fields.filter(
    (field) => field.filterable === true || field.sortable === true,
  );
  const width =
    TUPLE_HEADER_BYTES +
    KEY_BYTES +
    FIXED_COLUMN_BYTES +
    declared.reduce((sum, field) => sum + widestBytes(field), 0);
  if (width > MAX_INDEX_TUPLE_BYTES) {
    return { ok: false, error: { code: 'engine.filter_row_too_wide' } };
  }

  const ids = new Set<string>(declared.map((field) => field.id));
  const slots: Record<string, SlotEntry> = {};
  const clears: SlotWork[] = [];
  for (const [id, entry] of Object.entries(prior)) {
    if (ids.has(id)) slots[id] = entry;
    else if (hasItems) {
      slots[id] = { column: entry.column, state: 'clearing' };
      if (entry.state !== 'clearing') clears.push({ fieldId: id as FieldId, column: entry.column });
    }
  }

  const held = new Set(Object.values(slots).map((entry) => entry.column));
  const fills: SlotWork[] = [];
  for (const field of declared) {
    if (slots[field.id] !== undefined) continue;
    const column = freeColumn(field, held);
    if (column === null) {
      return { ok: false, error: { code: 'engine.filter_slot_busy', fieldId: field.id } };
    }
    held.add(column);
    slots[field.id] = { column, state: hasItems ? 'backfilling' : 'ready' };
    if (hasItems) fills.push({ fieldId: field.id, column });
  }
  return { ok: true, value: { slots, fills, clears } };
}

function slotValue(
  column: SlotColumn,
  value: StoredValue | undefined,
): string | readonly string[] | null {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value !== 'string') return value.map(String);
  // Year 0000 was once saved, and a rollback can bring it back. A scan reads it as missing too.
  return column.startsWith('d') && value.startsWith('0000-') ? null : value;
}

// Every column, so a value removed from a node cannot stay behind in its slot.
export function slotRowOf(slots: SlotMap, fields: StoredFields): SlotRow {
  const row = Object.fromEntries(SLOT_COLUMNS.map((column) => [column, null])) as Record<
    SlotColumn,
    string | readonly string[] | null
  >;
  for (const [id, entry] of Object.entries(slots)) {
    if (entry.state !== 'clearing') row[entry.column] = slotValue(entry.column, fields[id]);
  }
  return row;
}
