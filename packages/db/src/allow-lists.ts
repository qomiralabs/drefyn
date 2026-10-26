// The reviewed allow lists the catalog check reads. Every entry is a possible leak path, so
// each one carries a reason and goes through security review.

export interface AllowEntry {
  // Schema qualified, for example app.pgmigrations.
  readonly name: string;
  readonly reason: string;
}

export interface AllowLists {
  // Tables in app with no organization_id.
  readonly globalTables: readonly AllowEntry[];
  // SECURITY DEFINER functions in app, by regprocedure text, for example app.f(uuid).
  readonly securityDefinerFunctions: readonly AllowEntry[];
  // Tables drefyn_public_reader may select from.
  readonly publishedTables: readonly AllowEntry[];
  // Functions in app drefyn_public_reader may execute, by regprocedure text.
  readonly readerFunctions: readonly AllowEntry[];
}

export const GLOBAL_TABLES: readonly AllowEntry[] = [];
export const SECURITY_DEFINER_FUNCTIONS: readonly AllowEntry[] = [];
export const PUBLISHED_TABLES: readonly AllowEntry[] = [];
export const READER_FUNCTIONS: readonly AllowEntry[] = [];

export const ALLOW_LISTS: AllowLists = {
  globalTables: GLOBAL_TABLES,
  securityDefinerFunctions: SECURITY_DEFINER_FUNCTIONS,
  publishedTables: PUBLISHED_TABLES,
  readerFunctions: READER_FUNCTIONS,
};

// Published table names as the reader's transaction type sees them, without the schema.
export type PublishedTableName = never;
