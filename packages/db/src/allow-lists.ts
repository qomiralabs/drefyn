import { IDENTITY_COLUMN_GRANTS } from './identity-columns.ts';

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
  // Auth tables drefyn_app may hold no grant on at all, not even one column.
  readonly authOnlyTables: readonly AllowEntry[];
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
  {
    name: 'app.users',
    reason:
      'a person exists before and across organizations; rows are reached by self and auth policies',
  },
  {
    name: 'app.identities',
    reason: 'provider links of one person, keyed by user, never by tenant',
  },
  { name: 'app.sessions', reason: 'sessions of one person, keyed by user, never by tenant' },
  {
    name: 'app.password_credentials',
    reason: 'one hash per person, keyed by user; no organization scope reads it',
  },
  {
    name: 'app.email_challenges',
    reason: 'sign in codes exist before any user or organization is known',
  },
  { name: 'app.oauth_states', reason: 'OAuth round trips exist before anyone is signed in' },
  {
    name: 'app.auth_rate_limits',
    reason: 'sign in limits keyed by HMACs of addresses and IPs; holds no tenant data',
  },
  {
    name: 'app.api_key_failures',
    reason:
      'failed API key checks keyed by an HMAC of the client IP, checked before any key is proved',
  },
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

export const AUTH_TABLES: readonly AllowEntry[] = [
  {
    name: 'app.users',
    reason: 'sign in finds a person by address; sign up and email change write it',
  },
  { name: 'app.identities', reason: 'GitHub and Google sign in find and create provider links' },
  { name: 'app.password_credentials', reason: 'password sign in reads the hash and rehashes it' },
  { name: 'app.email_challenges', reason: 'email codes are created and redeemed before sign in' },
  { name: 'app.oauth_states', reason: 'OAuth state is created and redeemed before sign in' },
  { name: 'app.auth_rate_limits', reason: 'sign in limits are reserved before any work' },
];

const AUTH_ONLY = 'holds addresses of people who never signed up, codes or limiter keys';

export const AUTH_ONLY_TABLES: readonly AllowEntry[] = [
  { name: 'app.email_challenges', reason: AUTH_ONLY },
  { name: 'app.oauth_states', reason: AUTH_ONLY },
  { name: 'app.auth_rate_limits', reason: AUTH_ONLY },
];

const SELF = '(id = app.current_user_id())';
// The context withApiKeyLimiter sets: no organization, project or user.
const LIMITER_CONTEXT =
  '((app.current_org() IS NULL) AND (app.current_project() IS NULL) AND (app.current_user_id() IS NULL))';
const OWNED = '(user_id = app.current_user_id())';

// The sign in role reaches every row of its tables: it looks people up before anyone is
// known. Its grants, not these policies, decide which commands and columns it has.
const authAccess = (table: string, reason: string): PolicyEntry => ({
  name: `app.${table}.auth_access`,
  command: 'all',
  roles: ['drefyn_auth'],
  using: 'true',
  withCheck: 'true',
  reason,
});

const selfAccess = (table: string): PolicyEntry => ({
  name: `app.${table}.self_access`,
  command: 'all',
  roles: ['drefyn_app'],
  using: OWNED,
  withCheck: OWNED,
  reason: 'the signed in person reaches only their own rows; grants decide the commands',
});

export const USER_POLICIES: readonly PolicyEntry[] = [
  authAccess('users', 'sign in looks a person up by address before anyone is known'),
  {
    name: 'app.users.self_read',
    command: 'select',
    roles: ['drefyn_app'],
    using: SELF,
    withCheck: null,
    reason: 'the signed in person reads their own granted columns',
  },
  {
    name: 'app.users.self_update',
    command: 'update',
    roles: ['drefyn_app'],
    using: SELF,
    withCheck: SELF,
    reason: 'the signed in person changes their display name',
  },
  authAccess('identities', 'provider sign in looks up the link by provider subject'),
  selfAccess('identities'),
  selfAccess('sessions'),
  authAccess('password_credentials', 'password sign in reads and rehashes the hash'),
  selfAccess('password_credentials'),
  authAccess('email_challenges', 'codes are created and redeemed before sign in'),
  authAccess('oauth_states', 'OAuth state is created and redeemed before sign in'),
  authAccess('auth_rate_limits', 'limits are reserved before sign in'),
  {
    name: 'app.api_key_failures.api_access',
    command: 'all',
    roles: ['drefyn_app'],
    using: LIMITER_CONTEXT,
    withCheck: LIMITER_CONTEXT,
    reason:
      'failed key checks are counted before any key, and so any organization, is proved; only the empty context withApiKeyLimiter sets reaches the rows',
  },
];

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

export const COLUMN_GRANTS: readonly ColumnGrantEntry[] = IDENTITY_COLUMN_GRANTS.map((grant) => ({
  ...grant,
  reason:
    grant.grantee === 'drefyn_app'
      ? 'the signed in person reads or writes this column of their own row'
      : 'sign in, sign up or email change reads or writes this column',
}));

export const ALLOW_LISTS: AllowLists = {
  globalTables: GLOBAL_TABLES,
  securityDefinerFunctions: SECURITY_DEFINER_FUNCTIONS,
  publishedTables: PUBLISHED_TABLES,
  readerFunctions: READER_FUNCTIONS,
  appFunctions: APP_FUNCTIONS,
  crossProjectForeignKeys: CROSS_PROJECT_FOREIGN_KEYS,
  authTables: AUTH_TABLES,
  authOnlyTables: AUTH_ONLY_TABLES,
  userPolicies: USER_POLICIES,
  globalUniqueConstraints: GLOBAL_UNIQUE_CONSTRAINTS,
  columnGrantTables: COLUMN_GRANT_TABLES,
  columnGrants: COLUMN_GRANTS,
};

// Published table names as the reader's transaction type sees them, without the schema.
export type PublishedTableName = never;

// The tables AuthSchema and UserSchema name, without the schema.
export type AuthTableName =
  | 'users'
  | 'identities'
  | 'password_credentials'
  | 'email_challenges'
  | 'oauth_states'
  | 'auth_rate_limits';
export type UserTableName = 'users' | 'identities' | 'sessions' | 'password_credentials';

// Identity tables organization scope never names. users stays, for the members page.
export type PersonalTableName =
  Exclude<AuthTableName | UserTableName, 'users'> | 'api_key_failures';
