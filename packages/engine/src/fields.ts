import { canonicalInstant, parseUnits, type ContentSchema, type FieldDef } from '@drefyn/schema';
import { engineError, type EngineError, type EngineIssue, type EngineResult } from './errors.ts';

export type StoredScalar = string | boolean;
export type StoredValue = StoredScalar | readonly StoredScalar[];
export type StoredFields = Readonly<Record<string, StoredValue>>;

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const storable = (value: string) => !value.includes('\0') && value.isWellFormed();

function textValue(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string' || !storable(value)) return null;
  return encoder.encode(value).length <= maxBytes ? value : null;
}

function unitsOf(field: FieldDef & { kind: 'number' }, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const units = parseUnits(value, field.scale);
  return units === null ? null : String(units);
}

function numberValue(field: FieldDef & { kind: 'number' }, value: unknown): string | null {
  const text = unitsOf(field, value);
  if (text === null) return null;
  const units = BigInt(text);
  const min = field.min === undefined ? null : parseUnits(field.min, field.scale);
  const max = field.max === undefined ? null : parseUnits(field.max, field.scale);
  if ((min !== null && units < min) || (max !== null && units > max)) return null;
  return text;
}

// One form for a save and a filter, so a slot, a scan and the value compared with them agree.
// Numbers are integer units in a string: JSON numbers would pass through a float.
export function canonicalValue(field: FieldDef, value: unknown): StoredScalar | null {
  switch (field.kind) {
    case 'text':
    case 'markdown':
      return textValue(value, field.maxLength);
    case 'number':
      return numberValue(field, value);
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'date':
      return canonicalInstant(value, field.withTime);
    case 'reference':
      return typeof value === 'string' && UUID.test(value) ? value : null;
    default:
      return null;
  }
}

// A filter is not held to what a field may store: a bound or a length limits items, and a query
// past either one simply matches nothing.
export function filterValue(field: FieldDef, value: unknown): StoredScalar | null {
  switch (field.kind) {
    case 'list':
      return filterValue(field.of, value);
    case 'text':
    case 'markdown':
      return typeof value === 'string' ? value : null;
    case 'number':
      return unitsOf(field, value);
    default:
      return canonicalValue(field, value);
  }
}

const STORED_KINDS: ReadonlySet<FieldDef['kind']> = new Set([
  'text',
  'markdown',
  'number',
  'boolean',
  'date',
  'reference',
  'list',
]);

function listValue(element: FieldDef, value: unknown, maxItems: number): StoredScalar[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const items: StoredScalar[] = [];
  for (const item of value as readonly unknown[]) {
    const canonical = canonicalValue(element, item);
    if (canonical === null) return null;
    items.push(canonical);
  }
  return items;
}

const refused = (path: string, code: string): { ok: false; error: EngineError } => ({
  ok: false,
  error: engineError('engine.validation_failed', [{ path, code } satisfies EngineIssue]),
});

// A reference that points at many has no element definition of its own.
const singleTarget = (field: FieldDef & { kind: 'reference' }): FieldDef => ({
  ...field,
  many: false,
});

function storedValue(field: FieldDef, value: unknown): StoredValue | null {
  if (field.kind === 'list') return listValue(field.of, value, field.maxItems);
  if (field.kind === 'reference' && field.many) {
    return listValue(singleTarget(field), value, Number.MAX_SAFE_INTEGER);
  }
  return canonicalValue(field, value);
}

// Keys sorted, so the same values store the same bytes whatever order a client sent. An empty
// list is dropped, as exists has to read the same off a slot and off this map.
export function canonicalFields(
  schema: ContentSchema | null,
  raw: Readonly<Record<string, unknown>>,
  maxBytes: number,
): EngineResult<StoredFields> {
  const fields = new Map((schema?.fields ?? []).map((field) => [field.id as string, field]));
  const stored: Record<string, StoredValue> = {};
  for (const id of Object.keys(raw).sort()) {
    const path = `fields.${id}`;
    const field = fields.get(id);
    if (field === undefined) return refused(path, 'engine.field_unknown');
    if (!STORED_KINDS.has(field.kind)) return refused(path, 'engine.field_not_stored');
    const value = storedValue(field, raw[id]);
    if (value === null) return refused(path, 'engine.field_invalid');
    if (!Array.isArray(value) || value.length > 0) stored[id] = value;
  }
  if (Buffer.byteLength(JSON.stringify(stored), 'utf8') > maxBytes) {
    return {
      ok: false,
      error: engineError('engine.too_large', [{ path: 'fields', code: 'engine.fields_too_large' }]),
    };
  }
  return { ok: true, value: stored };
}
