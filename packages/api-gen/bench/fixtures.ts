import {
  asFieldId,
  asTypeId,
  type ContentSchema,
  type FieldDef,
  type FieldId,
  type TypeId,
} from '@drefyn/schema';

const uuid = (kind: string, n: number) =>
  `00000000-0000-7000-${kind}-${n.toString(16).padStart(12, '0')}`;

function fieldId(n: number): FieldId {
  const id = asFieldId(uuid('8000', n));
  if (id === undefined) throw new Error('bad bench id');
  return id;
}

function typeId(n: number): TypeId {
  const id = asTypeId(uuid('9000', n));
  if (id === undefined) throw new Error('bad bench id');
  return id;
}

// 20 fields per type, 4 of them references, the shape the budget was measured on.
function field(t: number, f: number): FieldDef {
  const base = {
    id: fieldId(t * 100 + f + 1),
    apiName: `field${String(f)}`,
    label: `Field ${String(f)}`,
    required: f % 4 === 0,
  };
  switch (f % 5) {
    case 0:
      return { ...base, kind: 'reference', to: [typeId(((t + 1) % 50) + 1)], many: f % 2 === 0 };
    case 1:
      return { ...base, kind: 'number', scale: 2, filterable: true };
    case 2:
      return { ...base, kind: 'date', withTime: true };
    case 3:
      return f === 3 ? { ...base, kind: 'rich_text' } : { ...base, kind: 'boolean' };
    default:
      return { ...base, kind: 'text', maxLength: 200 };
  }
}

export const TYPES: ContentSchema[] = Array.from({ length: 50 }, (_, t) => ({
  typeId: typeId(t + 1),
  apiName: `type${String(t)}`,
  version: 1,
  fields: Array.from({ length: 20 }, (_, f) => field(t, f)),
  deprecated: [fieldId(t * 100 + 2)],
  retired: [],
}));
