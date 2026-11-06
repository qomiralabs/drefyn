import { z } from 'zod';
import { AST_VERSION } from './types.ts';
import type { MdxLimits, MdxRoot, Result } from './types.ts';

export type TreeProblemCode =
  | 'tree.invalid_shape'
  | 'tree.invalid_text'
  | 'tree.forbidden_key'
  | 'tree.unknown_version'
  | 'tree.too_deep'
  | 'tree.too_many_nodes'
  | 'tree.too_large';

// Field names only: a problem can reach a log, and customer text must not.
export interface TreeProblem {
  readonly path: string;
  readonly code: TreeProblemCode;
}

interface Place {
  readonly parent: Place | null;
  readonly key: string | number;
}

interface Frame {
  readonly node: unknown;
  readonly depth: number;
  readonly place: Place;
  readonly top: boolean;
}

type Fields = Readonly<Record<string, unknown>>;

const MAX_PROBLEMS = 20;

// Renderers honour data and position costs bytes on every node. The rest are how a tree reaches
// a prototype once something copies it key by key.
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'data', 'position']);

const LEAF_LISTS = new Set(['children', 'attributes']);

const list = z.custom<readonly unknown[]>(Array.isArray);
const name = z.string().nullish();
const flag = z.boolean().nullish();
const referenceType = z.enum(['shortcut', 'collapsed', 'full']);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

const expressionValue = z.strictObject({
  type: z.literal('mdxJsxAttributeValueExpression'),
  value: z.string(),
});

// Fixed in depth, so reading one cannot recurse into anything a caller built.
const attributeSchema = z.union([
  z.strictObject({
    type: z.literal('mdxJsxAttribute'),
    name: z.string(),
    value: z.union([z.string(), expressionValue]).nullish(),
  }),
  z.strictObject({ type: z.literal('mdxJsxExpressionAttribute'), value: z.string() }),
]);

const sourceSchema = z.strictObject({
  raw: z.string(),
  gapBefore: z.string(),
  rawOf: sha256,
  sourceOf: sha256,
});

const parent = { children: list };
const literal = { value: z.string() };
const element = { name: z.string().nullable(), attributes: z.array(attributeSchema), ...parent };

// One closed key set per node type. Children stay opaque here and are walked one level at a
// time, so these schemas never recurse.
const SHAPES: Readonly<Record<string, z.ZodRawShape>> = {
  blockquote: parent,
  break: {},
  code: { lang: name, meta: name, ...literal },
  definition: { identifier: z.string(), label: name, title: name, url: z.string() },
  delete: parent,
  emphasis: parent,
  footnoteDefinition: { identifier: z.string(), label: name, ...parent },
  footnoteReference: { identifier: z.string(), label: name },
  heading: { depth: z.int().min(1).max(6), ...parent },
  html: literal,
  image: { alt: name, title: name, url: z.string() },
  imageReference: { alt: name, identifier: z.string(), label: name, referenceType },
  inlineCode: literal,
  link: { title: name, url: z.string(), ...parent },
  linkReference: { identifier: z.string(), label: name, referenceType, ...parent },
  list: { ordered: flag, spread: flag, start: z.int().nullish(), ...parent },
  listItem: { checked: flag, spread: flag, ...parent },
  mdxFlowExpression: literal,
  mdxJsxFlowElement: element,
  mdxJsxTextElement: element,
  mdxTextExpression: literal,
  mdxjsEsm: literal,
  paragraph: parent,
  strong: parent,
  table: { align: z.array(z.enum(['left', 'right', 'center']).nullable()).nullish(), ...parent },
  tableCell: parent,
  tableRow: parent,
  text: literal,
  thematicBreak: {},
  yaml: literal,
};

const schemasFor = (extra: z.ZodRawShape) =>
  new Map(
    Object.entries(SHAPES).map(([type, shape]) => [
      type,
      z.strictObject({ type: z.literal(type), ...shape, ...extra }),
    ]),
  );

const INNER_SCHEMAS = schemasFor({});
// Only top level blocks carry their source.
const BLOCK_SCHEMAS = schemasFor({ source: sourceSchema.optional() });

const rootSchema = z.strictObject({
  type: z.literal('root'),
  astVersion: z.literal(AST_VERSION),
  dialect: z.enum(['mdx', 'md']),
  eol: z.enum(['lf', 'crlf']),
  children: list,
  tail: z.string(),
  tailOf: sha256,
});

function isPlain(value: unknown): value is Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const child = (parent: Place, key: string | number): Place => ({ parent, key });

function pathOf(place: Place): string {
  const parts: (string | number)[] = [];
  for (let at: Place | null = place; at !== null; at = at.parent) {
    if (at.parent !== null) parts.push(at.key);
  }
  return parts.reverse().join('.');
}

class Walk {
  readonly problems: TreeProblem[] = [];
  private nodes = 0;
  private bytes = 0;
  private stopped = false;

  private readonly limits: MdxLimits;

  constructor(limits: MdxLimits) {
    this.limits = limits;
  }

  // True once a limit is passed, or the list of problems is long enough to act on.
  halted(): boolean {
    return this.stopped;
  }

  report(place: Place, code: TreeProblemCode): void {
    this.problems.push({ path: pathOf(place), code });
    if (this.problems.length >= MAX_PROBLEMS) this.stopped = true;
  }

  private limit(place: Place, code: TreeProblemCode): void {
    this.report(place, code);
    this.stopped = true;
  }

  // Length first: a list can claim billions of holes, and reading it would hang.
  fits(value: unknown, place: Place): void {
    if (Array.isArray(value) && value.length > this.limits.maxNodes) {
      this.limit(place, 'tree.too_many_nodes');
    }
  }

  deep(depth: number, place: Place): boolean {
    if (depth <= this.limits.maxDepth) return false;
    this.limit(place, 'tree.too_deep');
    return true;
  }

  count(amount: number, place: Place): void {
    this.nodes += amount;
    if (this.nodes > this.limits.maxNodes) this.limit(place, 'tree.too_many_nodes');
  }

  // A lower bound on the stored form, as JSON only adds escapes to this, so an honest tree at
  // the cap is never refused here.
  private text(key: string, value: string, place: Place): void {
    this.bytes += key.length + Buffer.byteLength(value, 'utf8') + 6;
    if (this.bytes > this.limits.maxBytes) this.limit(place, 'tree.too_large');
    // jsonb cannot hold either. Encoding them would break byte fidelity, and every lone
    // surrogate hashes as U+FFFD, so different bytes would share a hash.
    if (value.includes('\0') || !value.isWellFormed()) this.report(place, 'tree.invalid_text');
  }

  // Runs on fields a schema has passed, so the nesting here is fixed by those schemas.
  texts(fields: Fields, place: Place): void {
    for (const [key, value] of Object.entries(fields)) {
      if (this.stopped) return;
      if (key === 'type' || LEAF_LISTS.has(key)) continue;
      if (typeof value === 'string') this.text(key, value, child(place, key));
      else if (isPlain(value)) this.texts(value, child(place, key));
    }
  }

  forbidden(fields: Fields, place: Place): boolean {
    let found = false;
    for (const key of Object.keys(fields)) {
      if (!FORBIDDEN_KEYS.has(key)) continue;
      this.report(child(place, key), 'tree.forbidden_key');
      found = true;
    }
    return found;
  }

  // Before the schema, so the answer names the key and not only the node holding it.
  forbiddenInAttributes(node: Fields, place: Place): boolean {
    const { attributes } = node;
    if (!Array.isArray(attributes)) return false;
    let found = false;
    const within = child(place, 'attributes');
    for (const [index, attribute] of (attributes as readonly unknown[]).entries()) {
      if (!isPlain(attribute)) continue;
      const at = child(within, index);
      found = this.forbidden(attribute, at) || found;
      if (isPlain(attribute['value'])) {
        found = this.forbidden(attribute['value'], child(at, 'value')) || found;
      }
    }
    return found;
  }

  attributes(node: Fields, place: Place): void {
    const { attributes } = node;
    if (!Array.isArray(attributes)) return;
    const within = child(place, 'attributes');
    for (const [index, attribute] of (attributes as readonly Fields[]).entries()) {
      this.texts(attribute, child(within, index));
    }
  }
}

function pushChildren(stack: Frame[], children: readonly unknown[], depth: number, at: Place) {
  const place = child(at, 'children');
  // Backwards, so problems are found in document order.
  for (let index = children.length - 1; index >= 0; index -= 1) {
    stack.push({ node: children[index], depth, place: child(place, index), top: depth === 1 });
  }
}

function visit(frame: Frame, walk: Walk, stack: Frame[]): void {
  const { node, depth, place, top } = frame;
  if (walk.deep(depth, place)) return;
  if (!isPlain(node)) {
    walk.report(place, 'tree.invalid_shape');
    return;
  }
  const { children, attributes, type } = node;
  walk.fits(children, child(place, 'children'));
  walk.fits(attributes, child(place, 'attributes'));
  if (walk.halted()) return;
  const named = walk.forbidden(node, place);
  if (walk.forbiddenInAttributes(node, place) || named) return;
  const schema = typeof type === 'string' ? (top ? BLOCK_SCHEMAS : INNER_SCHEMAS).get(type) : null;
  if (!schema?.safeParse(node).success) {
    walk.report(place, 'tree.invalid_shape');
    return;
  }
  walk.count(1 + (Array.isArray(attributes) ? attributes.length : 0), place);
  walk.texts(node, place);
  walk.attributes(node, place);
  if (Array.isArray(children))
    pushChildren(stack, children as readonly unknown[], depth + 1, place);
}

// What the type promises, checked at run time, on trees from a client and from the parse host
// alike, since hostile pages run on that host. It keeps its own stack and spends its limits
// before anything recursive, a hash or JSON.stringify, may touch the tree.
export function validateTree(
  value: unknown,
  limits: MdxLimits,
): Result<MdxRoot, readonly TreeProblem[]> {
  const top: Place = { parent: null, key: '' };
  const walk = new Walk(limits);
  if (!isPlain(value)) return { ok: false, error: [{ path: '', code: 'tree.invalid_shape' }] };
  if (value['astVersion'] !== AST_VERSION) {
    walk.report(child(top, 'astVersion'), 'tree.unknown_version');
    return { ok: false, error: walk.problems };
  }
  const { children } = value;
  walk.fits(children, child(top, 'children'));
  if (walk.halted() || walk.forbidden(value, top) || !rootSchema.safeParse(value).success) {
    if (walk.problems.length === 0) walk.report(top, 'tree.invalid_shape');
    return { ok: false, error: walk.problems };
  }
  walk.texts(value, top);
  const stack: Frame[] = [];
  pushChildren(stack, children as readonly unknown[], 1, top);
  for (let frame = stack.pop(); frame !== undefined && !walk.halted(); frame = stack.pop()) {
    visit(frame, walk, stack);
  }
  return walk.problems.length === 0
    ? { ok: true, value: value as unknown as MdxRoot }
    : { ok: false, error: walk.problems };
}
