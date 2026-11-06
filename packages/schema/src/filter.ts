import { z } from 'zod';
import { exceedsBudget } from './bounded.ts';
import { parseUnits } from './decimal.ts';
import { isUuid } from './ids.ts';
import {
  MAX_FILTER_DEPTH,
  MAX_FILTER_IN_VALUES,
  MAX_FILTER_NODES,
  MAX_FILTER_TEXT_BYTES,
  UNDECLARED_FILTER_MAX_ITEMS,
} from './limits.ts';
import type {
  ContentSchema,
  FieldDef,
  FieldId,
  FilterCheck,
  FilterError,
  FilterErrorCode,
  FilterNode,
  FilterOp,
  FilterOptions,
  FilterValue,
  Result,
} from './types.ts';

// Each level is a node and its array, then a leaf with an `in` list. Past that it cannot
// be legal, and refusing here keeps zod's recursion off hostile nesting.
const FILTER_BUDGET = {
  maxDepth: 2 * MAX_FILTER_DEPTH + 2,
  maxValues: 8 * MAX_FILTER_NODES + MAX_FILTER_IN_VALUES * 4,
  maxChars: 262_144,
};

const failure = (code: FilterErrorCode, path = ''): { ok: false; error: FilterError } => ({
  ok: false,
  error: { code, path },
});

const filterNode: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(filterNode).min(1) }),
    z.strictObject({ or: z.array(filterNode).min(1) }),
    z.strictObject({ not: filterNode }),
    z.strictObject({
      field: z.custom<FieldId>(isUuid),
      op: z.enum(['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists']),
      value: z.union([z.string(), z.boolean(), z.array(z.string())]).exactOptional(),
    }),
  ]),
);

const children = (node: FilterNode): readonly FilterNode[] => {
  if ('and' in node) return node.and;
  if ('or' in node) return node.or;
  if ('not' in node) return [node.not];
  return [];
};

function fitsTree(root: FilterNode): boolean {
  const pending = [{ node: root, depth: 1 }];
  let count = 0;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    count += 1;
    if (next.depth > MAX_FILTER_DEPTH || count > MAX_FILTER_NODES) return false;
    for (const node of children(next.node)) pending.push({ node, depth: next.depth + 1 });
  }
  return true;
}

export function parseFilterNode(input: unknown): Result<FilterNode, FilterError> {
  if (exceedsBudget(input, FILTER_BUDGET) !== null) return failure('filter.too_large');
  const parsed = filterNode.safeParse(input);
  if (!parsed.success) return failure('filter.malformed');
  return fitsTree(parsed.data) ? { ok: true, value: parsed.data } : failure('filter.too_large');
}

const COMPARE: readonly FilterOp[] = ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'exists'];
const MATCH: readonly FilterOp[] = ['eq', 'neq', 'in', 'exists'];

function opsFor(field: FieldDef): readonly FilterOp[] {
  switch (field.kind) {
    case 'text':
      return [...COMPARE, 'contains'];
    case 'markdown':
      return ['contains', 'exists'];
    case 'number':
    case 'date':
      return COMPARE;
    case 'boolean':
      return ['eq', 'neq', 'exists'];
    case 'reference':
      return MATCH;
    case 'list': {
      const element = opsFor(field.of);
      return MATCH.filter((op) => element.includes(op));
    }
    // Rich text is a tree, so matching it would match the tree's JSON and not its words.
    default:
      return [];
  }
}

const encoder = new TextEncoder();
const dateOnly = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });

function fitsField(field: FieldDef, value: string | boolean): boolean {
  switch (field.kind) {
    case 'number':
      return typeof value === 'string' && parseUnits(value, field.scale) !== null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return (field.withTime ? dateTime : dateOnly).safeParse(value).success;
    case 'reference':
      return isUuid(value);
    case 'list':
      return fitsField(field.of, value);
    default:
      // Postgres text cannot hold NUL, so this would surface as a server error.
      return (
        typeof value === 'string' &&
        !value.includes('\u0000') &&
        encoder.encode(value).length <= MAX_FILTER_TEXT_BYTES
      );
  }
}

function fitsValue(field: FieldDef, op: FilterOp, value: FilterValue | undefined): boolean {
  if (op === 'exists') return value === undefined;
  if (value === undefined) return false;
  if (op === 'in') {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.length <= MAX_FILTER_IN_VALUES &&
      value.every((item: string) => fitsField(field, item))
    );
  }
  if (typeof value === 'object') return false;
  if (op === 'contains' && value === '') return false;
  return fitsField(field, value);
}

interface Scan {
  readonly fields: ReadonlyMap<FieldId, FieldDef>;
  readonly scanAllowed: boolean;
  readonly undeclared: Set<FieldId>;
}

function checkNode(node: FilterNode, path: string, scan: Scan): FilterError | null {
  const at = (key: string) => (path === '' ? key : `${path}.${key}`);
  if ('not' in node) return checkNode(node.not, at('not'), scan);
  if ('and' in node || 'or' in node) {
    const key = 'and' in node ? 'and' : 'or';
    let index = 0;
    for (const child of children(node)) {
      const error = checkNode(child, at(`${key}.${index}`), scan);
      if (error !== null) return error;
      index += 1;
    }
    return null;
  }
  const field = scan.fields.get(node.field);
  if (field === undefined) return { code: 'filter.field_unknown', path };
  if (!opsFor(field).includes(node.op)) return { code: 'filter.op_invalid', path };
  if (!fitsValue(field, node.op, node.value)) return { code: 'filter.value_invalid', path };
  // A sort only field has a slot too, but it was never offered as a filter.
  if (field.filterable !== true) {
    if (!scan.scanAllowed) return { code: 'filter.not_declared', path };
    scan.undeclared.add(field.id);
  }
  return null;
}

// Written so NaN, a negative count or a broken limit refuse the scan instead of passing a
// comparison by accident: a wrong count must not buy a full read of a large type.
function scanAllowed(options: FilterOptions): boolean {
  const { itemCount, undeclaredScanMaxItems = UNDECLARED_FILTER_MAX_ITEMS } = options;
  return Number.isSafeInteger(itemCount) && itemCount >= 0 && itemCount <= undeclaredScanMaxItems;
}

// Top level fields only: a slot holds one value per item, and a nested field has no slot.
export function checkFilter(
  schema: ContentSchema,
  input: unknown,
  options: FilterOptions,
): Result<FilterCheck, FilterError> {
  const parsed = parseFilterNode(input);
  if (!parsed.ok) return parsed;
  const scan: Scan = {
    fields: new Map(schema.fields.map((field) => [field.id, field])),
    scanAllowed: scanAllowed(options),
    undeclared: new Set(),
  };
  const error = checkNode(parsed.value, '', scan);
  if (error !== null) return { ok: false, error };
  return {
    ok: true,
    value: { filter: parsed.value, undeclared: [...scan.undeclared].sort() },
  };
}
