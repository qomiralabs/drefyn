import type { ContentSchema, FilterNode, TypeId } from '@drefyn/schema';
import type { TenantRef } from '@drefyn/tenancy';
import type { GraphQLSchema } from 'graphql';
import type { ApiFieldError, ContentErrorCode, GraphqlErrorCode } from './errors.ts';
import type { ContentFields } from './types.ts';

// What every request carries. Resolvers read the tenant from here and nowhere else.
export interface GraphqlContext {
  readonly tenant: TenantRef;
}

export interface ContentItem {
  readonly id: string;
  readonly versionId: string;
  readonly typeId: TypeId;
  // Keyed by field id, in the form the engine stores.
  readonly fields: ContentFields;
}

export interface ContentPage {
  readonly items: readonly ContentItem[];
  readonly nextCursor: string | null;
}

export interface ListArgs {
  readonly where: FilterNode | null;
  // A sortable field by API name, passed through as the REST `sort=` is.
  readonly sort: string | null;
  readonly limit: number;
  readonly cursor: string | null;
}

// Supplied by the API service. Every method takes the request context first, so no resolver
// can run without a tenant. Throw ContentApiError to answer with a REST code.
export interface ResolverSet<C extends GraphqlContext = GraphqlContext> {
  list(context: C, type: ContentSchema, args: ListArgs): Promise<ContentPage>;
  get(context: C, type: ContentSchema, id: string): Promise<ContentItem | null>;
  // One call per batch of reference ids. Answers in the same order, null where not found.
  load(context: C, ids: readonly string[]): Promise<readonly (ContentItem | null)[]>;
  create(
    context: C,
    type: ContentSchema,
    fields: ContentFields,
    options: { readonly idempotencyKey: string },
  ): Promise<ContentItem>;
  update(
    context: C,
    type: ContentSchema,
    id: string,
    fields: ContentFields,
    options: { readonly ifMatch: string },
  ): Promise<ContentItem>;
  delete(context: C, type: ContentSchema, id: string): Promise<void>;
}

export interface GraphqlEmitter {
  emit<C extends GraphqlContext>(
    types: readonly ContentSchema[],
    resolvers: ResolverSet<C>,
  ): GraphQLSchema;
}

export interface GraphqlRunOptions {
  // False for anonymous reads where the project turned introspection off.
  readonly introspection: boolean;
}

export interface GraphqlErrorOut {
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly locations?: readonly { readonly line: number; readonly column: number }[];
  readonly extensions: {
    readonly code: ContentErrorCode | GraphqlErrorCode;
    readonly fields?: readonly ApiFieldError[];
  };
}

export interface GraphqlResult {
  readonly data?: Readonly<Record<string, unknown>> | null;
  readonly errors?: readonly GraphqlErrorOut[];
}
