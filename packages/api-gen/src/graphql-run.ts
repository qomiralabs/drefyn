import {
  Kind,
  OperationTypeNode,
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
  execute,
  getNamedType,
  getOperationAST,
  getVariableValues,
  isCompositeType,
  isObjectType,
  isInterfaceType,
  parse,
  specifiedRules,
  validate,
  type DocumentNode,
  type GraphQLError,
  type FieldNode,
  type FragmentDefinitionNode,
  type InlineFragmentNode,
  type GraphQLCompositeType,
  type GraphQLField,
  type GraphQLSchema,
  type OperationDefinitionNode,
  type SelectionSetNode,
} from 'graphql';
import { z } from 'zod';
import {
  ContentApiError,
  ERROR_MESSAGES,
  type ContentErrorCode,
  type GraphqlErrorCode,
} from './errors.ts';
import { COST_KEY, RunState, type FieldCost } from './graphql-state.ts';
import type {
  GraphqlContext,
  GraphqlErrorOut,
  GraphqlResult,
  GraphqlRunOptions,
} from './graphql-types.ts';
import { DEFAULT_PAGE, MAX_PAGE } from './paging.ts';

export const GRAPHQL_LIMITS = Object.freeze({
  // Field nesting. Each reference costs two levels, the reference and its fields.
  maxDepth: 8,
  // Upper bound on items one query can read from storage.
  maxComplexity: 1_000,
  // Aliases let one field run many times, so they are counted across fragments too.
  maxAliases: 50,
  // The standard introspection query nests about 13 levels to unwrap types; nothing in it
  // reads content, so it gets its own bound instead of the content one.
  maxIntrospectionDepth: 16,
  // Bounds the parser, and so every walk over the document after it.
  maxTokens: 10_000,
  maxQueryLength: 100_000,
  // A rich text tree may nest 64 levels, two JSON levels each, inside nested fields.
  maxVariableDepth: 200,
  // Bounds the limit walk itself, which visits fragments once per spread.
  maxVisits: 10_000,
});

const requestSchema = z.strictObject({
  query: z.string().min(1).max(GRAPHQL_LIMITS.maxQueryLength),
  variables: z.record(z.string(), z.unknown()).nullish(),
  operationName: z.string().max(256).nullish(),
});

type Code = ContentErrorCode | GraphqlErrorCode;

const refusal = (code: Code): GraphqlResult => ({
  errors: [{ message: ERROR_MESSAGES[code], extensions: { code } }],
});

function tooDeep(value: unknown, max: number): boolean {
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 1 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (typeof next.value !== 'object' || next.value === null) continue;
    if (next.depth > max) return true;
    for (const child of Object.values(next.value)) {
      pending.push({ value: child, depth: next.depth + 1 });
    }
  }
  return false;
}

const INTROSPECTION = new Set(['__schema', '__type']);

class Refused extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(code);
    this.code = code;
  }
}

interface Walk {
  readonly schema: GraphQLSchema;
  readonly fragments: ReadonlyMap<string, FragmentDefinitionNode>;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly introspection: boolean;
  // Fragments being expanded right now. The document is not validated yet, so a cycle is
  // possible and must stop the walk.
  readonly active: Set<string>;
  aliases: number;
  visits: number;
}

function fieldDef(
  parent: GraphQLCompositeType,
  node: FieldNode,
  schema: GraphQLSchema,
): GraphQLField<unknown, unknown> | undefined {
  const name = node.name.value;
  if (name === '__typename') return TypeNameMetaFieldDef;
  if (parent === schema.getQueryType()) {
    if (name === '__schema') return SchemaMetaFieldDef;
    if (name === '__type') return TypeMetaFieldDef;
  }
  return isObjectType(parent) || isInterfaceType(parent) ? parent.getFields()[name] : undefined;
}

function pageSize(node: FieldNode, walk: Walk): number {
  const arg = node.arguments?.find((a) => a.name.value === 'limit');
  let value: unknown = DEFAULT_PAGE;
  if (arg?.value.kind === Kind.INT) value = Number(arg.value.value);
  else if (arg?.value.kind === Kind.VARIABLE) value = walk.variables[arg.value.name.value];
  else if (arg !== undefined && arg.value.kind !== Kind.NULL) value = Number.NaN;
  if (value === undefined) return DEFAULT_PAGE;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_PAGE) {
    throw new Refused('api.query_invalid');
  }
  return value;
}

const costOf = (field: GraphQLField<unknown, unknown>): FieldCost | undefined =>
  field.extensions[COST_KEY] as FieldCost | undefined;

// Walks the operation as it would run, fragments expanded, and refuses as soon as any limit
// is passed, so a hostile document costs at most the visit cap to reject.
function costOfSet(
  set: SelectionSetNode,
  parent: GraphQLCompositeType,
  depth: number,
  inIntrospection: boolean,
  walk: Walk,
): number {
  let total = 0;
  for (const selection of set.selections) {
    walk.visits += 1;
    if (walk.visits > GRAPHQL_LIMITS.maxVisits) throw new Refused('api.query_too_complex');
    if (selection.kind === Kind.FIELD) {
      total += costOfField(selection, parent, depth, inIntrospection, walk);
    } else {
      const name = selection.kind === Kind.FRAGMENT_SPREAD ? selection.name.value : null;
      const fragment: InlineFragmentNode | FragmentDefinitionNode | undefined =
        selection.kind === Kind.INLINE_FRAGMENT ? selection : walk.fragments.get(name ?? '');
      if (fragment === undefined || (name !== null && walk.active.has(name))) {
        throw new Refused('api.query_invalid');
      }
      const condition = fragment.typeCondition?.name.value;
      const type = condition === undefined ? parent : walk.schema.getType(condition);
      if (type === undefined || !isCompositeType(type)) {
        throw new Refused('api.query_invalid');
      }
      if (name !== null) walk.active.add(name);
      total += costOfSet(fragment.selectionSet, type, depth, inIntrospection, walk);
      if (name !== null) walk.active.delete(name);
    }
    if (total > GRAPHQL_LIMITS.maxComplexity) throw new Refused('api.query_too_complex');
  }
  return total;
}

function costOfField(
  node: FieldNode,
  parent: GraphQLCompositeType,
  depth: number,
  inIntrospection: boolean,
  walk: Walk,
): number {
  const name = node.name.value;
  const introspecting = inIntrospection || INTROSPECTION.has(name);
  if (INTROSPECTION.has(name) && !walk.introspection) {
    throw new Refused('api.introspection_disabled');
  }
  const maxDepth = introspecting ? GRAPHQL_LIMITS.maxIntrospectionDepth : GRAPHQL_LIMITS.maxDepth;
  if (depth > maxDepth) throw new Refused('api.query_too_deep');
  if (node.alias !== undefined) {
    walk.aliases += 1;
    if (walk.aliases > GRAPHQL_LIMITS.maxAliases) throw new Refused('api.query_too_complex');
  }
  const field = fieldDef(parent, node, walk.schema);
  if (field === undefined) throw new Refused('api.query_invalid');
  const cost = costOf(field) ?? { weight: 0, multiplier: 1 };
  const multiplier = cost.multiplier === 'limit' ? pageSize(node, walk) : cost.multiplier;
  const child = getNamedType(field.type);
  const inner =
    node.selectionSet !== undefined && isCompositeType(child)
      ? costOfSet(node.selectionSet, child, depth + 1, introspecting, walk)
      : 0;
  return multiplier * (cost.weight + inner);
}

function checkLimits(
  schema: GraphQLSchema,
  document: DocumentNode,
  operation: OperationDefinitionNode,
  variables: Readonly<Record<string, unknown>>,
  options: GraphqlRunOptions,
): Code | null {
  const root =
    operation.operation === OperationTypeNode.QUERY
      ? schema.getQueryType()
      : operation.operation === OperationTypeNode.MUTATION
        ? schema.getMutationType()
        : null;
  if (root === null || root === undefined) return 'api.query_invalid';
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  const walk: Walk = {
    schema,
    fragments,
    variables,
    introspection: options.introspection,
    active: new Set(),
    aliases: 0,
    visits: 0,
  };
  try {
    costOfSet(operation.selectionSet, root, 1, false, walk);
    return null;
  } catch (error) {
    if (error instanceof Refused) return error.code;
    throw error;
  }
}

function errorOut(error: GraphQLError): GraphqlErrorOut {
  const original = error.originalError;
  const known = original instanceof ContentApiError ? original : null;
  const code: Code = known?.code ?? 'api.internal';
  const extensions =
    known?.fields !== undefined && known.fields.length > 0
      ? { code, fields: known.fields }
      : { code };
  return {
    // Fixed text per code. A resolver's own message never reaches a client.
    message: ERROR_MESSAGES[code],
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.locations === undefined
      ? {}
      : { locations: error.locations.map(({ line, column }) => ({ line, column })) }),
    extensions,
  };
}

// The one way to run a query against an emitted schema. Every limit is checked on the parsed
// document before any resolver runs, and each refusal carries a stable code.
export async function runGraphql(
  schema: GraphQLSchema,
  request: unknown,
  context: GraphqlContext,
  options: GraphqlRunOptions,
): Promise<GraphqlResult> {
  const parsed = requestSchema.safeParse(request);
  if (!parsed.success) return refusal('api.query_invalid');
  const { query, variables, operationName } = parsed.data;
  let document: DocumentNode;
  try {
    document = parse(query, { maxTokens: GRAPHQL_LIMITS.maxTokens, noLocation: false });
  } catch {
    return refusal('api.query_invalid');
  }
  const operation = getOperationAST(document, operationName ?? undefined);
  if (operation === null || operation === undefined) return refusal('api.query_invalid');
  if (tooDeep(variables ?? {}, GRAPHQL_LIMITS.maxVariableDepth)) {
    return refusal('api.query_too_deep');
  }
  const coerced = getVariableValues(schema, operation.variableDefinitions ?? [], variables ?? {}, {
    maxErrors: 10,
  });
  if (coerced.errors !== undefined) return refusal('api.validation_failed');
  // Limits first: some standard rules grow with the square of a selection's size, so a
  // hostile document must be turned away before they see it.
  const refused = checkLimits(schema, document, operation, coerced.coerced, options);
  if (refused !== null) return refusal(refused);
  if (validate(schema, document, specifiedRules, { maxErrors: 10 }).length > 0) {
    return refusal('api.query_invalid');
  }
  const result = await execute({
    schema,
    document,
    operationName: operationName ?? null,
    variableValues: variables ?? {},
    contextValue: new RunState(context),
  });
  return {
    data: (result.data as Readonly<Record<string, unknown>> | null | undefined) ?? null,
    ...(result.errors === undefined ? {} : { errors: result.errors.map(errorOut) }),
  };
}
