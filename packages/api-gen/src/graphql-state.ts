import type { BatchLoader } from './batch-loader.ts';
import type { ContentItem, GraphqlContext } from './graphql-types.ts';

// The per request value resolvers see. Only runGraphql makes one, so the loader and its
// cache never outlive a request or cross between tenants.
export class RunState {
  readonly request: GraphqlContext;
  loader: BatchLoader<ContentItem> | undefined;

  constructor(request: GraphqlContext) {
    this.request = request;
    this.loader = undefined;
  }
}

// Read by the limit check before any resolver runs.
export interface FieldCost {
  // Items this field reads from storage for each value it returns.
  readonly weight: number;
  // How many values it can return: a number, or the page size the `limit` argument asks for.
  readonly multiplier: number | 'limit';
}

export const COST_KEY = 'drefynCost';
