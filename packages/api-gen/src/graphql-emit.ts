import {
  MAX_FILTER_IN_VALUES,
  type ContentSchema,
  type FieldDef,
  type FieldId,
  type TypeId,
} from '@drefyn/schema';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  Kind,
  validateSchema,
  valueFromASTUntyped,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLFieldResolver,
  type GraphQLInputFieldConfigMap,
  type GraphQLInputType,
  type GraphQLOutputType,
} from 'graphql';
import { createBatchLoader, type BatchLoader } from './batch-loader.ts';
import { ContentApiError } from './errors.ts';
import { decodeFilter } from './filter.ts';
import { SHARED, helperName, rootField } from './graphql-names.ts';
import { COST_KEY, RunState, type FieldCost } from './graphql-state.ts';
import type { ContentItem, GraphqlContext, GraphqlEmitter, ResolverSet } from './graphql-types.ts';
import { DEFAULT_PAGE, MAX_PAGE } from './paging.ts';
import type { ContentFields, Validator } from './types.ts';
import { compileValidator } from './validator.ts';

// A guess, not a bound: a many reference has no small declared maximum, and its true size is
// unknown until it loads. The loader's per request cap is the hard stop behind it.
export const MANY_REFERENCE_WEIGHT = 10;

// Reference ids per call to the load resolver, and distinct ids one request may load.
export const LOADER_MAX_BATCH = 1_000;
export const LOADER_MAX_KEYS = 10_000;

const DEPRECATION = 'Removed from the schema. Served until the removal is confirmed.';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Args = Record<string, unknown>;
type FieldConfig = GraphQLFieldConfig<unknown, RunState, Args>;

// Shared by every schema this process builds, so a cached schema holds only its own types.
// The scalars take what a client sends as it is; the validator and the filter check decide,
// so a bad value gets the same code from GraphQL as from REST.
const DECIMAL = new GraphQLScalarType<string, string>({
  name: SHARED.decimal,
  description: 'A decimal number as a string, at the field scale. Never a float.',
  serialize: (value) => {
    if (typeof value !== 'string') throw new TypeError('decimal: stored value is not a string');
    return value;
  },
  parseValue: (value) => {
    if (typeof value !== 'string') throw new TypeError('decimal: expected a string');
    return value;
  },
  parseLiteral: (node) => {
    if (node.kind !== Kind.STRING) throw new TypeError('decimal: expected a string');
    return node.value;
  },
});

const passThrough = (name: string, description: string) =>
  new GraphQLScalarType<unknown, unknown>({
    name,
    description,
    serialize: (value) => value,
    parseValue: (value) => value,
    parseLiteral: (node, variables) => valueFromASTUntyped(node, variables),
  });

const RICH_TEXT = passThrough(SHARED.richText, 'A rich text document tree.');
const FILTER_VALUE = passThrough(
  SHARED.filterValue,
  `A string, a boolean, or for in a list of up to ${String(MAX_FILTER_IN_VALUES)} strings.`,
);

const FILTER_OP = new GraphQLEnumType({
  name: SHARED.filterOp,
  values: Object.fromEntries(
    ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'].map((op) => [
      op,
      { value: op },
    ]),
  ),
});

// One filter input for every type. The field is named by API name as text, not an enum per
// type: an unknown name then gets filter.field_unknown exactly as REST gives it, and a cached
// schema does not carry a copy of every field list a second time.
const WHERE: GraphQLInputObjectType = new GraphQLInputObjectType({
  name: SHARED.where,
  description: 'One of and, or, not, or a field with an op and, except for exists, a value.',
  fields: () => ({
    and: { type: new GraphQLList(new GraphQLNonNull(WHERE)) },
    or: { type: new GraphQLList(new GraphQLNonNull(WHERE)) },
    not: { type: WHERE },
    field: { type: GraphQLString },
    op: { type: FILTER_OP },
    value: { type: FILTER_VALUE },
  }),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stateOf(context: unknown): RunState {
  if (!(context instanceof RunState)) throw new TypeError('graphql: run through runGraphql');
  return context;
}

const cost = (weight: number, multiplier: FieldCost['multiplier']): Record<string, FieldCost> => ({
  [COST_KEY]: { weight, multiplier },
});

const FREE: FieldCost = Object.freeze({ weight: 0, multiplier: 1 });
const ID_KEY = 'drefynId';

// Served as stored. One function for every such field instead of a closure each: closures
// were about a third of a cached schema's heap.
const readStored: GraphQLFieldResolver<unknown, unknown> = (parent, _args, _context, info) => {
  const id = info.parentType.getFields()[info.fieldName]?.extensions[ID_KEY];
  if (!isRecord(parent) || typeof id !== 'string') return null;
  return parent[id] ?? null;
};

type Transform = (raw: unknown, state: RunState) => unknown;

interface Build {
  readonly resolvers: ResolverSet;
  readonly all: readonly ContentSchema[];
  readonly entities: ReadonlyMap<TypeId, GraphQLObjectType>;
}

interface Target {
  readonly type: GraphQLOutputType;
  // Null when no target type is known, so the field serves the stored id.
  readonly allowed: ReadonlySet<TypeId> | null;
}

function loaderOf(state: RunState, build: Build): BatchLoader<ContentItem> {
  state.loader ??= createBatchLoader((ids) => build.resolvers.load(state.request, ids), {
    maxBatch: LOADER_MAX_BATCH,
    maxKeys: LOADER_MAX_KEYS,
  });
  return state.loader;
}

class TypeBuilder {
  readonly #build: Build;
  readonly #type: ContentSchema;

  constructor(build: Build, type: ContentSchema) {
    this.#build = build;
    this.#type = type;
  }

  // An empty target list means any type in the project.
  #target(field: FieldDef & { kind: 'reference' }, path: readonly string[]): Target {
    const known =
      field.to.length === 0
        ? this.#build.all
        : this.#build.all.filter((type) => field.to.includes(type.typeId));
    const types = known.flatMap((type) => {
      const entity = this.#build.entities.get(type.typeId);
      return entity === undefined ? [] : [{ id: type.typeId, entity }];
    });
    const allowed = new Set(types.map((type) => type.id));
    const [only] = types;
    if (only === undefined) return { type: GraphQLString, allowed: null };
    if (types.length === 1) return { type: only.entity, allowed };
    const names = new Map(types.map((type) => [type.id, type.entity.name]));
    const union = new GraphQLUnionType({
      name: helperName('Ref', this.#type.apiName, path),
      types: types.map((type) => type.entity).sort((a, b) => compareText(a.name, b.name)),
      resolveType: (value) =>
        isRecord(value) && typeof value['typeId'] === 'string'
          ? names.get(value['typeId'] as TypeId)
          : undefined,
    });
    return { type: union, allowed };
  }

  #output(
    field: FieldDef,
    path: readonly string[],
  ): {
    type: GraphQLOutputType;
    // Null when the stored value is served as it is.
    resolve: Transform | null;
    cost: FieldCost;
  } {
    const plain = { resolve: null, cost: FREE };
    switch (field.kind) {
      case 'text':
      case 'markdown':
      case 'date':
      case 'asset':
        return { type: GraphQLString, ...plain };
      case 'rich_text':
        return { type: RICH_TEXT, ...plain };
      case 'number':
        return { type: DECIMAL, ...plain };
      case 'boolean':
        return { type: GraphQLBoolean, ...plain };
      case 'reference': {
        const target = this.#target(field, path);
        const one = (id: unknown, state: RunState): unknown => {
          if (target.allowed === null || typeof id !== 'string') return id;
          const allowed = target.allowed;
          // A stored id that now points at another type, or at nothing, reads as null.
          return loaderOf(state, this.#build)
            .load(id)
            .then((item) => (item !== null && allowed.has(item.typeId) ? item : null));
        };
        const weight = target.allowed === null ? 0 : 1;
        if (!field.many)
          return { type: target.type, resolve: one, cost: { weight, multiplier: 1 } };
        return {
          type: new GraphQLList(target.type),
          resolve: (raw, state) => (Array.isArray(raw) ? raw.map((id) => one(id, state)) : null),
          cost: { weight, multiplier: MANY_REFERENCE_WEIGHT },
        };
      }
      case 'list': {
        const inner = this.#output(field.of, [...path, field.of.apiName]);
        const multiplier = inner.cost.multiplier === 'limit' ? 1 : inner.cost.multiplier;
        const each = inner.resolve;
        return {
          type: new GraphQLList(inner.type),
          resolve:
            each === null
              ? null
              : (raw, state) =>
                  Array.isArray(raw) ? raw.map((value) => each(value, state)) : null,
          cost:
            inner.cost.weight === 0
              ? FREE
              : { weight: inner.cost.weight, multiplier: field.maxItems * multiplier },
        };
      }
      case 'object':
        return {
          type: new GraphQLObjectType({
            name: helperName('Object', this.#type.apiName, path),
            fields: () => this.#outputFields(field.fields, path, new Set()),
          }),
          ...plain,
        };
    }
  }

  #outputFields(
    fields: readonly FieldDef[],
    path: readonly string[],
    deprecated: ReadonlySet<FieldId>,
  ): GraphQLFieldConfigMap<unknown, RunState> {
    const out: GraphQLFieldConfigMap<unknown, RunState> = {};
    for (const field of fields) {
      const built = this.#output(field, [...path, field.apiName]);
      const transform = built.resolve;
      const config: FieldConfig = {
        type: built.type,
        resolve:
          transform === null
            ? readStored
            : (parent, _args, context) => {
                const raw = isRecord(parent) ? parent[field.id] : undefined;
                return raw === undefined || raw === null ? null : transform(raw, stateOf(context));
              },
        extensions: { [COST_KEY]: built.cost, [ID_KEY]: field.id },
      };
      out[field.apiName] = deprecated.has(field.id)
        ? { ...config, deprecationReason: DEPRECATION }
        : config;
    }
    return out;
  }

  #input(field: FieldDef, path: readonly string[]): GraphQLInputType {
    switch (field.kind) {
      case 'text':
      case 'markdown':
      case 'date':
      case 'asset':
        return GraphQLString;
      case 'rich_text':
        return RICH_TEXT;
      case 'number':
        return DECIMAL;
      case 'boolean':
        return GraphQLBoolean;
      case 'reference':
        return field.many ? new GraphQLList(GraphQLString) : GraphQLString;
      case 'list':
        return new GraphQLList(this.#input(field.of, [...path, field.of.apiName]));
      case 'object':
        return new GraphQLInputObjectType({
          name: helperName('ObjectInput', this.#type.apiName, path),
          fields: () => this.#inputFields(field.fields, path, new Set()),
        });
    }
  }

  // Every input field is nullable, so a missing required field reaches the validator and gets
  // the same field.required code REST gives.
  #inputFields(
    fields: readonly FieldDef[],
    path: readonly string[],
    deprecated: ReadonlySet<FieldId>,
  ): GraphQLInputFieldConfigMap {
    const out: GraphQLInputFieldConfigMap = {};
    for (const field of fields) {
      const type = this.#input(field, [...path, field.apiName]);
      out[field.apiName] = deprecated.has(field.id)
        ? { type, deprecationReason: DEPRECATION }
        : { type };
    }
    return out;
  }

  entity(): GraphQLObjectType {
    const type = this.#type;
    const deprecated = new Set(type.deprecated);
    const fields = new GraphQLObjectType({
      name: helperName('Fields', type.apiName),
      fields: () => this.#outputFields(type.fields, [], deprecated),
    });
    return new GraphQLObjectType({
      name: type.apiName,
      fields: {
        id: { type: new GraphQLNonNull(GraphQLString) },
        versionId: { type: new GraphQLNonNull(GraphQLString) },
        fields: { type: new GraphQLNonNull(fields) },
      },
    });
  }

  queryFields(entity: GraphQLObjectType): GraphQLFieldConfigMap<unknown, RunState> {
    const type = this.#type;
    const resolvers = this.#build.resolvers;
    const page = new GraphQLObjectType({
      name: helperName('Page', type.apiName),
      fields: {
        items: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(entity))),
          extensions: cost(1, 1),
        },
        nextCursor: { type: GraphQLString },
      },
    });
    const get: FieldConfig = {
      type: entity,
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      extensions: cost(1, 1),
      resolve: (_source, args, context) => {
        const state = stateOf(context);
        const id = args['id'];
        if (typeof id !== 'string' || !UUID.test(id)) return null;
        return resolvers.get(state.request, type, id);
      },
    };
    const list: FieldConfig = {
      type: new GraphQLNonNull(page),
      args: {
        where: { type: WHERE },
        sort: { type: GraphQLString },
        limit: { type: GraphQLInt, defaultValue: DEFAULT_PAGE },
        cursor: { type: GraphQLString },
      },
      extensions: cost(0, 'limit'),
      resolve: (_source, args, context) => {
        const state = stateOf(context);
        const limit = args['limit'];
        if (
          typeof limit !== 'number' ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > MAX_PAGE
        ) {
          throw new ContentApiError('api.query_invalid');
        }
        let where = null;
        if (args['where'] !== undefined && args['where'] !== null) {
          const decoded = decodeFilter(type, args['where']);
          if (!decoded.ok) throw new ContentApiError('api.filter_invalid', decoded.error.fields);
          where = decoded.value;
        }
        const text = (value: unknown) => (typeof value === 'string' ? value : null);
        return resolvers.list(state.request, type, {
          where,
          sort: text(args['sort']),
          limit,
          cursor: text(args['cursor']),
        });
      },
    };
    return { [rootField('get', type.apiName)]: get, [rootField('list', type.apiName)]: list };
  }

  mutationFields(entity: GraphQLObjectType): GraphQLFieldConfigMap<unknown, RunState> {
    const type = this.#type;
    const resolvers = this.#build.resolvers;
    const input = new GraphQLNonNull(
      new GraphQLInputObjectType({
        name: helperName('Input', type.apiName),
        fields: () => this.#inputFields(type.fields, [], new Set(type.deprecated)),
      }),
    );
    let validator: Validator | undefined;
    // Compiled on first write, so a schema that only serves reads never pays for it.
    const validate = (value: unknown): ContentFields => {
      validator ??= compileValidator(type);
      const result = validator(value);
      if (!result.ok) throw new ContentApiError('api.validation_failed', result.error);
      return result.value;
    };
    const required = (name: string) => ({ [name]: { type: new GraphQLNonNull(GraphQLString) } });
    const idOf = (args: Args): string => {
      const id = args['id'];
      if (typeof id !== 'string' || !UUID.test(id)) throw new ContentApiError('api.not_found');
      return id;
    };
    const create: FieldConfig = {
      type: new GraphQLNonNull(entity),
      args: { input: { type: input }, ...required('idempotencyKey') },
      extensions: cost(1, 1),
      resolve: (_source, args, context) => {
        const state = stateOf(context);
        const fields = validate(args['input']);
        return resolvers.create(state.request, type, fields, {
          idempotencyKey: String(args['idempotencyKey']),
        });
      },
    };
    const update: FieldConfig = {
      type: new GraphQLNonNull(entity),
      args: { ...required('id'), input: { type: input }, ...required('ifMatch') },
      extensions: cost(1, 1),
      resolve: (_source, args, context) => {
        const state = stateOf(context);
        const id = idOf(args);
        const fields = validate(args['input']);
        return resolvers.update(state.request, type, id, fields, {
          ifMatch: String(args['ifMatch']),
        });
      },
    };
    const remove: FieldConfig = {
      type: new GraphQLNonNull(GraphQLBoolean),
      args: required('id'),
      extensions: cost(1, 1),
      resolve: async (_source, args, context) => {
        const state = stateOf(context);
        await resolvers.delete(state.request, type, idOf(args));
        return true;
      },
    };
    return {
      [rootField('create', type.apiName)]: create,
      [rootField('update', type.apiName)]: update,
      [rootField('delete', type.apiName)]: remove,
    };
  }
}

// Built from graphql-js constructors only. No schema text is ever assembled, so a name can
// never inject SDL, and the same types give the same schema whatever order they arrive in.
function emit<C extends GraphqlContext>(
  types: readonly ContentSchema[],
  resolvers: ResolverSet<C>,
): GraphQLSchema {
  const sorted = [...types].sort((a, b) => compareText(a.apiName, b.apiName));
  const seen = new Set<string>();
  for (const type of sorted) {
    // Matches the REST rule: some clients fold case, so two names that differ only in case
    // would reach one route.
    const folded = type.apiName.toLowerCase();
    if (seen.has(folded)) throw new TypeError('graphql: two types share an API name');
    seen.add(folded);
  }
  const entities = new Map<TypeId, GraphQLObjectType>();
  const build: Build = { resolvers, all: sorted, entities };
  const builders = sorted.map((type) => new TypeBuilder(build, type));
  for (const [index, builder] of builders.entries()) {
    const type = sorted[index];
    if (type !== undefined) entities.set(type.typeId, builder.entity());
  }
  const query: GraphQLFieldConfigMap<unknown, RunState> = {};
  const mutation: GraphQLFieldConfigMap<unknown, RunState> = {};
  for (const [index, builder] of builders.entries()) {
    const type = sorted[index];
    const entity = type === undefined ? undefined : entities.get(type.typeId);
    if (entity === undefined) continue;
    Object.assign(query, builder.queryFields(entity));
    Object.assign(mutation, builder.mutationFields(entity));
  }
  // A project with no types yet still needs a valid schema, and a root type needs a field.
  if (sorted.length === 0) query['_empty'] = { type: GraphQLBoolean, resolve: () => null };
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: query }),
    ...(sorted.length > 0
      ? { mutation: new GraphQLObjectType({ name: 'Mutation', fields: mutation }) }
      : {}),
  });
  if (validateSchema(schema).length > 0) throw new TypeError('graphql: the schema is not valid');
  return schema;
}

export const graphqlEmitter: GraphqlEmitter = { emit };
