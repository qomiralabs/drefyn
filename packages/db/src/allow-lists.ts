// The reviewed allow lists the catalog check reads. Every entry is a possible leak path, so
// each one carries a reason and goes through security review.

export interface AllowEntry {
  // Schema qualified, for example app.pgmigrations.
  readonly name: string;
  readonly reason: string;
}

// A permissive policy other than tenant_isolation and published_read, in the form
// pg_get_expr prints with search_path = pg_catalog, so a reviewer compares exact text.
export interface PolicyEntry extends AllowEntry {
  // app.table.policy
  readonly command: 'all' | 'select' | 'insert' | 'update' | 'delete';
  readonly roles: readonly string[];
  readonly using: string | null;
  readonly withCheck: string | null;
}

// One privilege on one column, as app.table.column.
export interface ColumnGrantEntry extends AllowEntry {
  readonly grantee: string;
  readonly privilege: string;
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
  // Functions in app drefyn_app may execute, by regprocedure text.
  readonly appFunctions: readonly AllowEntry[];
  // Foreign keys between project tables that may leave project_id out, as
  // app.table.constraint: a reviewed reference across projects of one organization.
  readonly crossProjectForeignKeys: readonly AllowEntry[];
  // Tables drefyn_auth may hold grants on. A table with organization_id is refused even here.
  readonly authTables: readonly AllowEntry[];
  // Reviewed policies beyond the two standard ones, compared field by field.
  readonly userPolicies: readonly PolicyEntry[];
  // Unique keys on tenant tables without organization_id, as app.table.index.
  readonly globalUniqueConstraints: readonly AllowEntry[];
  // Tables whose select and update grants must be per column, so a new column is never
  // readable or writable until someone grants it.
  readonly columnGrantTables: readonly AllowEntry[];
  // The column grants those tables may carry.
  readonly columnGrants: readonly ColumnGrantEntry[];
}

const BOOKKEEPING = 'migration bookkeeping, owner only, no tenant data';

export const GLOBAL_TABLES: readonly AllowEntry[] = [
  { name: 'app.pgmigrations', reason: BOOKKEEPING },
  { name: 'app.migration_checksums', reason: BOOKKEEPING },
];

export const SECURITY_DEFINER_FUNCTIONS: readonly AllowEntry[] = [];

export const PUBLISHED_TABLES: readonly AllowEntry[] = [];

export const READER_FUNCTIONS: readonly AllowEntry[] = [
  { name: 'app.current_org()', reason: 'reads the transaction setting the reader policies need' },
  {
    name: 'app.current_project()',
    reason: 'reads the transaction setting the reader policies need',
  },
];

export const APP_FUNCTIONS: readonly AllowEntry[] = [
  { name: 'app.current_org()', reason: 'reads the transaction setting every tenant policy needs' },
  {
    name: 'app.current_project()',
    reason: 'reads the transaction setting every tenant policy needs',
  },
  {
    name: 'app.current_user_id()',
    reason: 'reads the transaction setting the user keyed policies need',
  },
];

export const CROSS_PROJECT_FOREIGN_KEYS: readonly AllowEntry[] = [];

export const AUTH_TABLES: readonly AllowEntry[] = [];

export const USER_POLICIES: readonly PolicyEntry[] = [];

export const GLOBAL_UNIQUE_CONSTRAINTS: readonly AllowEntry[] = [];

export const COLUMN_GRANT_TABLES: readonly AllowEntry[] = [
  {
    name: 'app.users',
    reason: 'a future column must not become readable by member_read or writable by self_update',
  },
  {
    name: 'app.password_credentials',
    reason: 'holds password hashes; each role gets exactly the columns its flows use',
  },
];

export const COLUMN_GRANTS: readonly ColumnGrantEntry[] = [];

export const ALLOW_LISTS: AllowLists = {
  globalTables: GLOBAL_TABLES,
  securityDefinerFunctions: SECURITY_DEFINER_FUNCTIONS,
  publishedTables: PUBLISHED_TABLES,
  readerFunctions: READER_FUNCTIONS,
  appFunctions: APP_FUNCTIONS,
  crossProjectForeignKeys: CROSS_PROJECT_FOREIGN_KEYS,
  authTables: AUTH_TABLES,
  userPolicies: USER_POLICIES,
  globalUniqueConstraints: GLOBAL_UNIQUE_CONSTRAINTS,
  columnGrantTables: COLUMN_GRANT_TABLES,
  columnGrants: COLUMN_GRANTS,
};

// Published table names as the reader's transaction type sees them, without the schema.
export type PublishedTableName = never;

// The tables AuthSchema and UserSchema name, without the schema. The identity tables issue
// fills both.
export type AuthTableName = never;
export type UserTableName = never;
