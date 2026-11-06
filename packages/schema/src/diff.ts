import { parseUnits } from './decimal.ts';
import type {
  ContentSchema,
  FieldDef,
  FieldId,
  Scale,
  SchemaDiff,
  SchemaIssue,
  SchemaIssueReason,
} from './types.ts';

interface Placed {
  readonly field: FieldDef;
  readonly parent: FieldId | null;
  readonly path: string;
  readonly element: boolean;
}

function visit(
  field: FieldDef,
  path: string,
  parent: FieldId | null,
  into: Map<FieldId, Placed>,
  element = false,
): void {
  into.set(field.id, { field, parent, path, element });
  if (field.kind === 'list') visit(field.of, `${path}.of`, field.id, into, true);
  if (field.kind === 'object') {
    field.fields.forEach((child, index) => {
      visit(child, `${path}.fields.${index}`, field.id, into);
    });
  }
}

const placed = (schema: ContentSchema): Map<FieldId, Placed> => {
  const into = new Map<FieldId, Placed>();
  schema.fields.forEach((field, index) => {
    visit(field, `fields.${index}`, null, into);
  });
  return into;
};

// Code unit order, so the result does not depend on the host's locale.
const sorted = (ids: Iterable<FieldId>): FieldId[] =>
  [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const raises = (
  before: string | undefined,
  after: string | undefined,
  scale: Scale,
  sign: 1n | -1n,
): boolean => {
  if (after === undefined) return false;
  if (before === undefined) return true;
  const a = parseUnits(before, scale);
  const b = parseUnits(after, scale);
  if (a === null || b === null) return true;
  return sign * b > sign * a;
};

// A value that was valid must stay valid and mean the same. The type check at the top is
// what lets each case read both sides as one kind.
function kindChange(before: FieldDef, after: FieldDef): SchemaIssueReason | null {
  switch (before.kind) {
    case 'text': {
      if (after.kind !== 'text') return 'retyped';
      if (after.maxLength < before.maxLength) return 'narrowed';
      const format = after.format ?? 'plain';
      return format !== 'plain' && format !== before.format ? 'narrowed' : null;
    }
    case 'markdown':
      if (after.kind !== 'markdown') return 'retyped';
      return after.maxLength < before.maxLength ? 'narrowed' : null;
    case 'number':
      if (after.kind !== 'number' || after.scale !== before.scale) return 'retyped';
      return raises(before.min, after.min, before.scale, 1n) ||
        raises(before.max, after.max, before.scale, -1n)
        ? 'narrowed'
        : null;
    case 'date':
      return after.kind !== 'date' || after.withTime !== before.withTime ? 'retyped' : null;
    case 'asset':
      if (after.kind !== 'asset') return 'retyped';
      return before.accept.every((type) => after.accept.includes(type)) ? null : 'narrowed';
    case 'reference':
      if (after.kind !== 'reference' || after.many !== before.many) return 'retyped';
      return before.to.every((type) => after.to.includes(type)) ? null : 'narrowed';
    case 'list':
      if (after.kind !== 'list') return 'retyped';
      return after.maxItems < before.maxItems ? 'narrowed' : null;
    default:
      return after.kind === before.kind ? null : 'retyped';
  }
}

function fieldChange(
  before: FieldDef,
  after: FieldDef,
  deprecated: ReadonlySet<FieldId>,
): SchemaIssueReason | null {
  if (after.apiName !== before.apiName) return 'renamed';
  const kind = kindChange(before, after);
  if (kind === 'retyped') return kind;
  if ((after.localized ?? false) !== (before.localized ?? false)) return 'retyped';
  if (after.required && !before.required) return 'required_added';
  // Once deprecated, new writers should not have to keep filling it in.
  if (before.required && !after.required && !deprecated.has(after.id)) return 'required_dropped';
  if (before.filterable === true && after.filterable !== true) return 'undeclared';
  if (before.sortable === true && after.sortable !== true) return 'undeclared';
  if (after.unique === true && before.unique !== true) return 'narrowed';
  return kind;
}

// Children are compared through their own entries, so they stay out of this.
const own = (field: FieldDef): string =>
  JSON.stringify(
    Object.entries(field)
      .filter(([key]) => key !== 'fields' && key !== 'of')
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );

export interface DiffOutcome {
  readonly value: SchemaDiff;
  readonly issues: readonly SchemaIssue[];
}

function identityIssues(next: ContentSchema, prior: ContentSchema): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const breaking = (path: string, reason: SchemaIssueReason) =>
    issues.push({ path, code: 'schema.breaking_in_place', reason });
  if (next.typeId !== prior.typeId) breaking('typeId', 'identity');
  if (next.apiName !== prior.apiName) breaking('apiName', 'renamed');
  if (next.version !== prior.version + 1) breaking('version', 'version');
  return issues;
}

export function diffSchemas(
  next: ContentSchema,
  prior: ContentSchema | null,
  confirmedRemovals: readonly FieldId[],
): DiffOutcome {
  const after = placed(next);
  if (prior === null) {
    return {
      issues: [],
      value: {
        fromVersion: null,
        toVersion: next.version,
        additive: true,
        added: sorted(after.keys()),
        changed: [],
        deprecated: [],
        restored: [],
        removed: [],
      },
    };
  }

  const before = placed(prior);
  const nowDeprecated = new Set(next.deprecated);
  const wasDeprecated = new Set(prior.deprecated);
  const confirmed = new Set(confirmedRemovals);
  const retired = new Set(prior.retired);
  const issues = identityIssues(next, prior);
  const removed = new Set<FieldId>();
  const changed = new Set<FieldId>();
  const breaking = (path: string, fieldId: FieldId, reason: SchemaIssueReason) =>
    issues.push({ path, code: 'schema.breaking_in_place', reason, fieldId });

  // Map order is depth first, so a parent is always settled before its children.
  for (const [id, was] of before) {
    const now = after.get(id);
    if (now === undefined) {
      if (was.parent !== null && removed.has(was.parent)) removed.add(id);
      // The element is the list's type, so losing it while the list lives is a retype,
      // and no confirmation can make that safe.
      else if (was.element) breaking(was.path, id, 'retyped');
      else if (!wasDeprecated.has(id)) breaking(was.path, id, 'removed');
      else if (confirmed.has(id)) removed.add(id);
      else breaking(was.path, id, 'removal_unconfirmed');
      continue;
    }
    if (now.parent !== was.parent) {
      breaking(now.path, id, 'moved');
      continue;
    }
    const reason = fieldChange(was.field, now.field, nowDeprecated);
    if (reason !== null) breaking(now.path, id, reason);
    else if (own(was.field) !== own(now.field)) changed.add(id);
  }

  const fresh = [...after].filter(([id]) => !before.has(id));
  for (const [id, { field, parent, path }] of fresh) {
    if (retired.has(id)) breaking(path, id, 'reused');
    // Children of a new parent are new with it, so no writer has been sending them.
    else if (field.required && (parent === null || before.has(parent))) {
      breaking(path, id, 'required_added');
    }
  }

  // Exact, so a client can neither forget a removal nor erase one to reuse an id.
  const expected = new Set([...retired, ...removed]);
  if (expected.size !== next.retired.length || !next.retired.every((id) => expected.has(id))) {
    issues.push({ path: 'retired', code: 'schema.breaking_in_place', reason: 'retired' });
  }

  const deprecated = sorted(next.deprecated.filter((id) => !wasDeprecated.has(id)));
  const value: SchemaDiff = {
    fromVersion: prior.version,
    toVersion: next.version,
    additive: deprecated.length === 0 && removed.size === 0,
    added: sorted(fresh.map(([id]) => id)),
    changed: sorted(changed),
    deprecated,
    restored: sorted(prior.deprecated.filter((id) => after.has(id) && !nowDeprecated.has(id))),
    removed: sorted(removed),
  };
  return { value, issues };
}
