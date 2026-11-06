import { parseUnits } from './decimal.ts';
import { diffSchemas } from './diff.ts';
import {
  FILTER_SLOTS,
  MAX_ACCEPTED_TYPES,
  MAX_FIELD_DEPTH,
  MAX_FIELDS,
  MAX_LABEL_LENGTH,
  MAX_LIST_ITEMS,
  MAX_REFERENCE_TARGETS,
  MAX_RETIRED_FIELDS,
  MAX_TEXT_BYTES,
} from './limits.ts';
import { checkApiName } from './names.ts';
import { failure, parseContentSchema } from './parse.ts';
import { slotClassOf, type SlotClass } from './slots.ts';
import type {
  ContentSchema,
  FieldDef,
  FieldId,
  Result,
  SchemaDiff,
  SchemaError,
  SchemaIssue,
  SchemaIssueReason,
  TypeId,
  ValidateOptions,
} from './types.ts';

const SLOT_REASON: Record<SlotClass, SchemaIssueReason> = {
  text: 'text_slots',
  integer: 'integer_slots',
  time: 'time_slots',
};

interface Walk {
  readonly issues: SchemaIssue[];
  readonly known: ReadonlySet<TypeId>;
  readonly ids: Set<FieldId>;
  readonly slots: Record<SlotClass, number>;
  count: number;
}

function checkNumber(field: FieldDef & { kind: 'number' }, path: string, walk: Walk): void {
  const min = field.min === undefined ? undefined : parseUnits(field.min, field.scale);
  const max = field.max === undefined ? undefined : parseUnits(field.max, field.scale);
  const bad = min === null || max === null;
  if (bad || (min !== undefined && max !== undefined && min > max)) {
    walk.issues.push({ path, code: 'schema.malformed' });
  }
}

function checkDeclaration(field: FieldDef, path: string, nested: boolean, walk: Walk): void {
  const takesSlot = field.filterable === true || field.sortable === true;
  if (!takesSlot && field.unique !== true) return;
  const refuse = (reason: SchemaIssueReason) =>
    walk.issues.push({ path, code: 'schema.limit_reached', reason });
  if (nested) {
    refuse('nested_declaration');
    return;
  }
  const slot = slotClassOf(field);
  // text[] has no order to walk, so a list can filter but not sort.
  if (slot === null || (field.kind === 'list' && field.sortable === true)) {
    refuse('not_declarable');
    return;
  }
  if (!takesSlot) return;
  walk.slots[slot] += 1;
  if (walk.slots[slot] > FILTER_SLOTS[slot]) refuse(SLOT_REASON[slot]);
}

function checkKind(field: FieldDef, path: string, depth: number, walk: Walk): void {
  const tooLarge = (at: string) => walk.issues.push({ path: at, code: 'schema.too_large' });
  switch (field.kind) {
    case 'text':
    case 'markdown':
      if (field.maxLength > MAX_TEXT_BYTES) tooLarge(`${path}.maxLength`);
      return;
    case 'number':
      checkNumber(field, path, walk);
      return;
    case 'asset':
      if (field.accept.length > MAX_ACCEPTED_TYPES) tooLarge(`${path}.accept`);
      return;
    case 'reference':
      if (field.to.length > MAX_REFERENCE_TARGETS) tooLarge(`${path}.to`);
      if (field.to.length === 0) {
        walk.issues.push({ path: `${path}.to`, code: 'schema.reference_unknown' });
      }
      field.to.forEach((target, index) => {
        if (!walk.known.has(target)) {
          walk.issues.push({ path: `${path}.to.${index}`, code: 'schema.reference_unknown' });
        }
      });
      return;
    case 'list':
      if (field.maxItems > MAX_LIST_ITEMS) tooLarge(`${path}.maxItems`);
      checkField(field.of, `${path}.of`, depth + 1, true, new Set(), walk);
      return;
    case 'object':
      checkFields(field.fields, `${path}.fields`, depth + 1, true, walk);
      return;
    default:
      return;
  }
}

function checkField(
  field: FieldDef,
  path: string,
  depth: number,
  nested: boolean,
  names: Set<string>,
  walk: Walk,
): void {
  walk.count += 1;
  if (walk.count === MAX_FIELDS + 1) walk.issues.push({ path, code: 'schema.too_large' });
  if (depth > MAX_FIELD_DEPTH) {
    walk.issues.push({ path, code: 'schema.too_deep' });
    return;
  }
  const nameIssue = checkApiName(field.apiName);
  if (nameIssue !== null) walk.issues.push({ path: `${path}.apiName`, code: nameIssue });
  // Some generated clients fold case, so `title` and `Title` would be one property there.
  const folded = field.apiName.toLowerCase();
  if (names.has(folded)) {
    walk.issues.push({ path: `${path}.apiName`, code: 'schema.name_collision' });
  }
  names.add(folded);
  // Ids are unique across the whole type, as filters and slots name a field by id alone.
  if (walk.ids.has(field.id)) {
    walk.issues.push({ path: `${path}.id`, code: 'schema.name_collision' });
  }
  walk.ids.add(field.id);
  if (field.label.length > MAX_LABEL_LENGTH) {
    walk.issues.push({ path: `${path}.label`, code: 'schema.too_large' });
  }
  checkDeclaration(field, path, nested, walk);
  checkKind(field, path, depth, walk);
}

function checkFields(
  fields: readonly FieldDef[],
  path: string,
  depth: number,
  nested: boolean,
  walk: Walk,
): void {
  const names = new Set<string>();
  fields.forEach((field, index) => {
    checkField(field, `${path}.${index}`, depth, nested, names, walk);
  });
}

function checkStructure(schema: ContentSchema, known: ReadonlySet<TypeId>): SchemaIssue[] {
  const walk: Walk = {
    issues: [],
    known: new Set([...known, schema.typeId]),
    ids: new Set(),
    slots: { text: 0, integer: 0, time: 0 },
    count: 0,
  };
  const nameIssue = checkApiName(schema.apiName);
  if (nameIssue !== null) walk.issues.push({ path: 'apiName', code: nameIssue });
  checkFields(schema.fields, 'fields', 1, false, walk);
  schema.deprecated.forEach((id, index) => {
    if (!walk.ids.has(id)) {
      walk.issues.push({ path: `deprecated.${index}`, code: 'schema.reference_unknown' });
    }
  });
  if (schema.retired.length > MAX_RETIRED_FIELDS) {
    walk.issues.push({ path: 'retired', code: 'schema.too_large' });
  }
  return walk.issues;
}

// `prior` is the stored version and is trusted. `next` is not, so it is parsed here even
// when a caller already holds a ContentSchema.
export function validateSchema(
  next: ContentSchema,
  prior: ContentSchema | null,
  options: ValidateOptions = {},
): Result<SchemaDiff, SchemaError> {
  const parsed = parseContentSchema(next);
  if (!parsed.ok) return parsed;
  const schema = parsed.value;
  const issues = checkStructure(schema, options.knownTypes ?? new Set());
  if (issues.length > 0) return failure(issues);
  if (prior === null && schema.version !== 1) {
    return failure([{ path: 'version', code: 'schema.malformed' }]);
  }
  if (prior === null && schema.retired.length > 0) {
    return failure([{ path: 'retired', code: 'schema.malformed' }]);
  }
  const diff = diffSchemas(schema, prior, options.confirmedRemovals ?? []);
  return diff.issues.length > 0 ? failure(diff.issues) : { ok: true, value: diff.value };
}
