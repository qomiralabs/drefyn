import type { PublishedDatabase } from '@drefyn/db';
import type { TenantRef } from '@drefyn/tenancy';
import { publishedReader } from '../../src/index.ts';
import {
  parseSearchRow,
  prepareRead,
  searchStatement,
  type SearchRow,
} from '../../src/statement.ts';
import type { Caps } from './reference.ts';

export interface ScoredSearch extends SearchRow {
  readonly hits: SearchRow['hits'];
}

// The statement retrieve runs, with its scores and counts, which the library never returns.
export async function scoredSearch(
  reader: PublishedDatabase,
  tenant: TenantRef,
  query: string,
  caps: Caps,
  options: {
    readonly limit?: number;
    readonly pathPrefix?: string;
    readonly scored?: boolean;
  } = {},
): Promise<ScoredSearch> {
  return publishedReader(reader).read(tenant, 10_000, async (tx) => {
    await prepareRead(tx, 10_000);
    const { rows } = await searchStatement(tenant, {
      label: 'latest',
      query,
      limit: options.limit ?? 20,
      pathPrefix: options.pathPrefix ?? null,
      scored: options.scored ?? true,
      caps,
    }).execute(tx);
    const row = parseSearchRow(rows[0]);
    if (row === null) throw new Error('the statement returned a row of another shape');
    return row;
  });
}
