import { organizationId, projectId } from '@drefyn/tenancy';
import type { ContentSchema, FilterNode, TypeId } from '@drefyn/schema';
import type { GraphQLSchema } from 'graphql';
import {
  graphqlEmitter,
  runGraphql,
  type ContentFields,
  type ContentItem,
  type GraphqlContext,
  type GraphqlResult,
  type ListArgs,
  type ResolverSet,
} from '../src/index.ts';
import { ORG, PRJ } from './support.ts';

export const CONTEXT: GraphqlContext = {
  tenant: { organizationId: organizationId(ORG), projectId: projectId(PRJ) },
};

export const itemId = (n: number) => `00000000-0000-7000-a000-${n.toString(16).padStart(12, '0')}`;
export const VERSION = '00000000-0000-7000-b000-000000000001';

export interface Calls {
  list: ListArgs[];
  get: string[];
  load: (readonly string[])[];
  create: ContentFields[];
  update: ContentFields[];
  delete: string[];
}

export interface FakeStore {
  readonly resolvers: ResolverSet;
  readonly calls: Calls;
  readonly items: Map<string, ContentItem>;
  total(): number;
}

// An in memory stand in for the engine. It records every call so tests can prove what ran
// and how often.
export function fakeStore(): FakeStore {
  const items = new Map<string, ContentItem>();
  const calls: Calls = { list: [], get: [], load: [], create: [], update: [], delete: [] };
  const created = (type: ContentSchema, fields: ContentFields): ContentItem => ({
    id: itemId(9999),
    versionId: VERSION,
    typeId: type.typeId,
    fields,
  });
  const resolvers: ResolverSet = {
    list: (_context, type, args) => {
      calls.list.push(args);
      const page = [...items.values()]
        .filter((item) => item.typeId === type.typeId)
        .slice(0, args.limit);
      return Promise.resolve({ items: page, nextCursor: null });
    },
    get: (_context, _type, id) => {
      calls.get.push(id);
      return Promise.resolve(items.get(id) ?? null);
    },
    load: (_context, ids) => {
      calls.load.push(ids);
      return Promise.resolve(ids.map((id) => items.get(id) ?? null));
    },
    create: (_context, type, fields) => {
      calls.create.push(fields);
      return Promise.resolve(created(type, fields));
    },
    update: (_context, type, _id, fields) => {
      calls.update.push(fields);
      return Promise.resolve(created(type, fields));
    },
    delete: (_context, _type, id) => {
      calls.delete.push(id);
      return Promise.resolve();
    },
  };
  const total = () =>
    calls.list.length +
    calls.get.length +
    calls.load.length +
    calls.create.length +
    calls.update.length +
    calls.delete.length;
  return { resolvers, calls, items, total };
}

export function put(store: FakeStore, typeId: TypeId, n: number, fields: ContentFields): string {
  const id = itemId(n);
  store.items.set(id, { id, versionId: VERSION, typeId, fields });
  return id;
}

export function emitWith(types: readonly ContentSchema[], store: FakeStore): GraphQLSchema {
  return graphqlEmitter.emit(types, store.resolvers);
}

export function run(
  schema: GraphQLSchema,
  query: string,
  variables?: Record<string, unknown>,
  introspection = true,
): Promise<GraphqlResult> {
  return runGraphql(schema, { query, variables }, CONTEXT, { introspection });
}

export const lastWhere = (store: FakeStore): FilterNode | null | undefined =>
  store.calls.list.at(-1)?.where;
