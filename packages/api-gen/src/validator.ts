import { DEFAULT_LIMITS, validateTree } from '@drefyn/mdx';
import {
  MAX_LIST_ITEMS,
  canonicalInstant,
  formatUnits,
  parseUnits,
  type ContentSchema,
  type FieldDef,
  type FieldId,
} from '@drefyn/schema';
import { z } from 'zod';
import type {
  ContentFields,
  ContentValue,
  FieldIssue,
  FieldIssueCode,
  Validator,
} from './types.ts';

// Bounds an error a client reads, however much of the input is wrong.
const MAX_ISSUES = 50;

const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// Lower case only, the form the engine stores and compares.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const email = z.email();
const url = z.url({ protocol: /^https?$/ });

const encoder = new TextEncoder();

type Checked = { readonly value: ContentValue } | { readonly code: FieldIssueCode };

interface Walk {
  readonly issues: FieldIssue[];
  readonly deprecated: ReadonlySet<FieldId>;
}

const fail = (code: FieldIssueCode): Checked => ({ code });
const pass = (value: ContentValue): Checked => ({ value });

function isPlain(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkText(value: unknown, maxBytes: number, format?: string): Checked {
  if (typeof value !== 'string') return fail('field.type');
  // Postgres text cannot hold NUL and jsonb cannot hold a lone surrogate.
  if (value.includes('\u0000') || !value.isWellFormed()) return fail('field.text');
  if (encoder.encode(value).length > maxBytes) return fail('field.too_long');
  const formatted =
    format === 'slug'
      ? SLUG.test(value)
      : format === 'email'
        ? email.safeParse(value).success
        : format === 'url'
          ? url.safeParse(value).success
          : true;
  return formatted ? pass(value) : fail('field.format');
}

// A JSON number passes through a float on the way in, so only the decimal string is taken.
function checkNumber(field: FieldDef & { kind: 'number' }, value: unknown): Checked {
  if (typeof value !== 'string') return fail('field.type');
  const units = parseUnits(value, field.scale);
  if (units === null) return fail('field.number');
  const min = field.min === undefined ? null : parseUnits(field.min, field.scale);
  const max = field.max === undefined ? null : parseUnits(field.max, field.scale);
  if ((min !== null && units < min) || (max !== null && units > max)) return fail('field.range');
  return pass(formatUnits(units, field.scale));
}

// A day is already in its one form; an instant is stored in UTC so equal times store equal bytes.
function checkDate(field: FieldDef & { kind: 'date' }, value: unknown): Checked {
  if (typeof value !== 'string') return fail('field.type');
  const instant = canonicalInstant(value, field.withTime);
  if (instant === null) return fail('field.date');
  return pass(field.withTime ? instant : value);
}

function checkId(value: unknown): Checked {
  if (typeof value !== 'string') return fail('field.type');
  return UUID.test(value) ? pass(value) : fail('field.format');
}

function checkList(
  value: unknown,
  maxItems: number,
  path: string,
  walk: Walk,
  item: (value: unknown, path: string) => Checked | null,
): Checked | null {
  if (!Array.isArray(value)) return fail('field.type');
  // Length first, so a huge array costs one comparison.
  if (value.length > maxItems) return fail('field.too_many');
  const out: ContentValue[] = [];
  let failed = false;
  for (const [index, element] of (value as readonly unknown[]).entries()) {
    const at = `${path}.${String(index)}`;
    const checked = element === null ? fail('field.type') : item(element, at);
    if (checked === null) {
      failed = true;
    } else if ('code' in checked) {
      failed = true;
      walk.issues.push({ path: at, code: checked.code });
    } else {
      out.push(checked.value);
    }
  }
  return failed ? null : pass(out);
}

// Null means the field reports its own issues and has already pushed them.
function checkValue(field: FieldDef, value: unknown, path: string, walk: Walk): Checked | null {
  switch (field.kind) {
    case 'text':
      return checkText(value, field.maxLength, field.format);
    case 'markdown':
      return checkText(value, field.maxLength);
    case 'rich_text': {
      const tree = validateTree(value, DEFAULT_LIMITS);
      return tree.ok ? pass(tree.value) : fail('field.rich_text');
    }
    case 'number':
      return checkNumber(field, value);
    case 'boolean':
      return typeof value === 'boolean' ? pass(value) : fail('field.type');
    case 'date':
      return checkDate(field, value);
    case 'asset':
      return checkId(value);
    case 'reference':
      return field.many ? checkList(value, MAX_LIST_ITEMS, path, walk, checkId) : checkId(value);
    case 'list':
      return checkList(value, field.maxItems, path, walk, (element, at) =>
        checkValue(field.of, element, at, walk),
      );
    case 'object': {
      if (!isPlain(value)) return fail('field.type');
      const fields = checkFields(field.fields, value, `${path}.`, walk);
      return fields === null ? null : pass(fields);
    }
  }
}

// An empty list reads the same as no list: the engine drops it, so a filter on exists agrees.
const isEmpty = (field: FieldDef, value: unknown) =>
  value === null ||
  ((field.kind === 'list' || (field.kind === 'reference' && field.many)) &&
    Array.isArray(value) &&
    value.length === 0);

function checkFields(
  fields: readonly FieldDef[],
  input: Readonly<Record<string, unknown>>,
  prefix: string,
  walk: Walk,
): ContentFields | null {
  const byName = new Map(fields.map((field) => [field.apiName, field]));
  const before = walk.issues.length;
  for (const key of Object.keys(input)) {
    if (!byName.has(key)) {
      // A key a client made up is its own text, so it is named only when it could be a name.
      const path = API_NAME.test(key) ? `${prefix}${key}` : prefix.slice(0, -1);
      walk.issues.push({ path, code: 'field.unknown' });
    }
  }
  const out: [string, ContentValue][] = [];
  for (const field of fields) {
    const path = `${prefix}${field.apiName}`;
    const value = Object.hasOwn(input, field.apiName) ? input[field.apiName] : undefined;
    if (value === undefined || isEmpty(field, value)) {
      if (field.required && !walk.deprecated.has(field.id)) {
        walk.issues.push({ path, code: 'field.required' });
      }
      continue;
    }
    const checked = checkValue(field, value, path, walk);
    if (checked === null) continue;
    if ('code' in checked) walk.issues.push({ path, code: checked.code });
    else out.push([field.id, checked.value]);
  }
  if (walk.issues.length > before) return null;
  out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(out);
}

const byPathThenCode = (a: FieldIssue, b: FieldIssue) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

// Input is keyed by API name, as a client sends it; output by field id, as the engine stores it.
export function compileValidator(schema: ContentSchema): Validator {
  const deprecated: ReadonlySet<FieldId> = new Set(schema.deprecated);
  return (input) => {
    if (!isPlain(input)) return { ok: false, error: [{ path: '', code: 'field.type' }] };
    const walk: Walk = { issues: [], deprecated };
    const value = checkFields(schema.fields, input, '', walk);
    if (value === null) {
      return { ok: false, error: walk.issues.sort(byPathThenCode).slice(0, MAX_ISSUES) };
    }
    return { ok: true, value };
  };
}
