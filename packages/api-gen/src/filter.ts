import {
  MAX_FILTER_DEPTH,
  MAX_FILTER_NODES,
  checkFilter,
  type ContentSchema,
  type FieldId,
  type FilterErrorCode,
  type FilterNode,
} from '@drefyn/schema';
import type { FilterParamError } from './types.ts';

// The largest legal tree, written out with in lists of long values, stays well under this, and
// a longer query string than this does not survive most proxies anyway.
export const MAX_FILTER_PARAM_LENGTH = 16_384;

type Mapped =
  | { readonly ok: true; readonly node: unknown }
  | { readonly ok: false; readonly code: FilterErrorCode; readonly path: string };

const refused = (code: FilterErrorCode, path = ''): { ok: false; error: FilterParamError } => ({
  ok: false,
  error: { code: 'api.filter_invalid', fields: [{ path, code }] },
});

function isPlain(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const LEAF_KEYS: ReadonlySet<string> = new Set(['field', 'op', 'value']);

interface Walk {
  readonly names: ReadonlyMap<string, FieldId>;
  nodes: number;
}

// Size is a property of the whole tree, so it has no one place to point at.
const stop = (code: FilterErrorCode, path: string): Mapped => ({
  ok: false,
  code,
  path: code === 'filter.too_large' ? '' : path,
});

const at = (path: string, key: string) => (path === '' ? key : `${path}.${key}`);

// Rebuilds the tree with field ids in place of API names. Depth and size are checked on the way
// down, so the walk itself never goes deeper than a legal tree.
function mapNode(input: unknown, path: string, depth: number, walk: Walk): Mapped {
  walk.nodes += 1;
  if (depth > MAX_FILTER_DEPTH || walk.nodes > MAX_FILTER_NODES) {
    return stop('filter.too_large', path);
  }
  if (!isPlain(input)) return stop('filter.malformed', path);
  const keys = Object.keys(input);
  const only = keys.length === 1 ? keys[0] : undefined;
  if (only === 'and' || only === 'or') {
    const list = input[only];
    if (!Array.isArray(list)) return stop('filter.malformed', path);
    if (list.length > MAX_FILTER_NODES) return stop('filter.too_large', path);
    const children: unknown[] = [];
    for (const [index, child] of (list as readonly unknown[]).entries()) {
      const mapped = mapNode(child, at(path, `${only}.${String(index)}`), depth + 1, walk);
      if (!mapped.ok) return mapped;
      children.push(mapped.node);
    }
    return { ok: true, node: { [only]: children } };
  }
  if (only === 'not') {
    const mapped = mapNode(input['not'], at(path, 'not'), depth + 1, walk);
    return mapped.ok ? { ok: true, node: { not: mapped.node } } : mapped;
  }
  if (keys.length === 0 || !keys.every((key) => LEAF_KEYS.has(key))) {
    return stop('filter.malformed', path);
  }
  const name = input['field'];
  if (typeof name !== 'string') return stop('filter.malformed', path);
  const field = walk.names.get(name);
  if (field === undefined) return stop('filter.field_unknown', path);
  const node: Record<string, unknown> = { field, op: input['op'] };
  if (Object.hasOwn(input, 'value')) node['value'] = input['value'];
  return { ok: true, node };
}

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

// The `filter=` query parameter: the same closed tree GraphQL and saved views use, with fields
// named by API name. Only top level fields can be named, as only they have a slot.
export function parseFilterParam(
  schema: ContentSchema,
  raw: unknown,
): { ok: true; value: FilterNode } | { ok: false; error: FilterParamError } {
  if (typeof raw !== 'string') return refused('filter.malformed');
  if (raw.length > MAX_FILTER_PARAM_LENGTH) return refused('filter.too_large');
  const parsed = parseJson(raw);
  if (!parsed.ok) return refused('filter.malformed');
  const walk: Walk = {
    names: new Map(schema.fields.map((field) => [field.apiName, field.id])),
    nodes: 0,
  };
  const mapped = mapNode(parsed.value, '', 1, walk);
  if (!mapped.ok) return refused(mapped.code, mapped.path);
  // Undeclared fields pass here; the engine knows the type's size and decides whether to scan.
  const checked = checkFilter(schema, mapped.node, { itemCount: 0 });
  if (!checked.ok) return refused(checked.error.code, checked.error.path);
  return { ok: true, value: checked.value.filter };
}
