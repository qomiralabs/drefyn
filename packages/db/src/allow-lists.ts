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
  // Every restrictive policy in app, compared the same way. A guard that goes missing widens
  // what the permissive policies let through, so a listed one that is absent fails too.
  readonly restrictivePolicies: readonly PolicyEntry[];
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
    name: 'app.cli_sign_in_links',
    reason: 'pre sign in, operator issued, user id and hash only',
  },
  {
    name: 'app.auth_rate_limits',
    reason: 'sign in limits keyed by HMACs of addresses and IPs; holds no tenant data',
  },
  {
    name: 'app.api_key_failures',
    reason:
      'failed API key checks keyed by an HMAC of the client IP, checked before any key is proved',
  },
  {
    name: 'app.known_devices',
    reason: 'browsers one person signed in from, keyed by user, never by tenant',
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
  {
    name: 'app.current_actor_id()',
    reason:
      'reads the person acting in organization work, for restrictive policies only; a permissive one fails the actor rule',
  },
  {
    name: 'app.install_tier()',
    reason: 'the insert guard on organizations compares the new tier with the install tier',
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
  {
    name: 'app.cli_sign_in_links',
    reason: 'the operator command writes links and redemption marks them used before sign in',
  },
  { name: 'app.auth_rate_limits', reason: 'sign in limits are reserved before any work' },
  {
    name: 'app.known_devices',
    reason:
      'the send limit checks a device before sign in; the cleanup deletes devices unseen for 400 days',
  },
];

const AUTH_ONLY = 'holds addresses of people who never signed up, codes or limiter keys';

export const AUTH_ONLY_TABLES: readonly AllowEntry[] = [
  { name: 'app.email_challenges', reason: AUTH_ONLY },
  { name: 'app.oauth_states', reason: AUTH_ONLY },
  { name: 'app.cli_sign_in_links', reason: 'holds hashes of sign in links issued before sign in' },
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

// pg_get_expr prints the subquery over three lines; kept exact so review compares the text.
const memberOf = (table: string) =>
  `(EXISTS ( SELECT\n   FROM app.memberships m\n  WHERE ((m.organization_id = ${table}.organization_id) AND (m.user_id = app.current_user_id()))))`;

const memberRead = (table: string, reason: string): PolicyEntry => ({
  name: `app.${table}.member_read`,
  command: 'select',
  roles: ['drefyn_app'],
  using: memberOf(table),
  withCheck: null,
  reason,
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
  {
    name: 'app.users.member_read',
    command: 'select',
    roles: ['drefyn_app'],
    using:
      '(EXISTS ( SELECT\n   FROM app.memberships m\n  WHERE ((m.user_id = users.id) AND (m.organization_id = app.current_org()))))',
    withCheck: null,
    reason:
      'organization work reads the people who belong to it, through the granted columns only; nobody outside it',
  },
  authAccess('identities', 'provider sign in looks up the link by provider subject'),
  selfAccess('identities'),
  selfAccess('sessions'),
  authAccess('password_credentials', 'password sign in reads and rehashes the hash'),
  selfAccess('password_credentials'),
  authAccess('email_challenges', 'codes are created and redeemed before sign in'),
  authAccess('oauth_states', 'OAuth state is created and redeemed before sign in'),
  authAccess(
    'cli_sign_in_links',
    'operator links are written and redeemed before sign in; grants allow updating consumed_at only',
  ),
  authAccess('auth_rate_limits', 'limits are reserved before sign in'),
  selfAccess('known_devices'),
  {
    name: 'app.known_devices.auth_read',
    command: 'select',
    roles: ['drefyn_auth'],
    using: 'true',
    withCheck: null,
    reason: 'the send limit checks a device before anyone is signed in; grants allow 4 columns',
  },
  {
    name: 'app.known_devices.auth_expire',
    command: 'delete',
    roles: ['drefyn_auth'],
    using: "(last_seen_at < (now() - '400 days'::interval))",
    withCheck: null,
    reason: 'the expiry cleanup may remove only devices unseen for 400 days, whatever it sends',
  },
  {
    name: 'app.api_key_failures.api_access',
    command: 'all',
    roles: ['drefyn_app'],
    using: LIMITER_CONTEXT,
    withCheck: LIMITER_CONTEXT,
    reason:
      'failed key checks are counted before any key, and so any organization, is proved; only the empty context withApiKeyLimiter sets reaches the rows',
  },
  {
    name: 'app.memberships.self_read',
    command: 'select',
    roles: ['drefyn_app'],
    using: OWNED,
    withCheck: null,
    reason: 'the signed in person lists the organizations they belong to; never a write',
  },
  memberRead(
    'organizations',
    'a member reads the organization under a user context; a non member reads nothing',
  ),
  memberRead(
    'organization_slugs',
    'a member resolves the slug under a user context; a non member slug resolves to nothing',
  ),
];

// The inviter is the person acting, and their stored role bounds the role they invite: an
// owner any, an admin admin or member, a member none.
const INVITER_GRANTS_ROLE =
  "(EXISTS ( SELECT\n   FROM app.memberships m\n  WHERE ((m.organization_id = invitations.organization_id) AND (m.id = invitations.invited_by) AND (m.user_id = app.current_actor_id()) AND ((m.role = 'owner'::text) OR ((m.role = 'admin'::text) AND (invitations.role <> 'owner'::text))))))";

// The person acting, as the first owner of an organization made in this transaction, or as a
// member the database can see invited: a live invitation of this organization, named by the
// row, with the same role. Kept exact, as pg_get_expr prints it.
const MEMBERSHIP_ORIGIN =
  "((user_id = app.current_actor_id()) AND (((role = 'owner'::text) AND (NOT (EXISTS ( SELECT\n   FROM app.memberships m\n  WHERE (m.organization_id = memberships.organization_id)))) AND (EXISTS ( SELECT\n   FROM app.organizations o\n  WHERE ((o.organization_id = memberships.organization_id) AND (o.created_at = now()))))) OR (EXISTS ( SELECT\n   FROM app.invitations i\n  WHERE ((i.organization_id = memberships.organization_id) AND (i.id = memberships.invitation_id) AND (i.role = memberships.role) AND (i.expires_at > now()))))))";

const KEY_CREATOR =
  "(EXISTS ( SELECT\n   FROM app.memberships m\n  WHERE ((m.organization_id = api_keys.organization_id) AND (m.id = api_keys.created_by) AND (m.user_id = app.current_actor_id()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text])))))";

// The person acting holds an owner membership, or an admin one and the row is no owner's.
const MEMBER_ACTOR =
  "(EXISTS ( SELECT\n   FROM app.memberships a\n  WHERE ((a.organization_id = memberships.organization_id) AND (a.user_id = app.current_actor_id()) AND ((a.role = 'owner'::text) OR ((a.role = 'admin'::text) AND (memberships.role <> 'owner'::text))))))";

// Another owner of the organization than this row.
const OTHER_OWNER =
  "(EXISTS ( SELECT\n   FROM app.memberships o\n  WHERE ((o.organization_id = memberships.organization_id) AND (o.role = 'owner'::text) AND (o.id <> memberships.id))))";

// The person acting is an owner or admin of the row's organization.
const PROJECT_ROLE_ACTOR =
  "(EXISTS ( SELECT\n   FROM app.memberships a\n  WHERE ((a.organization_id = project_roles.organization_id) AND (a.user_id = app.current_actor_id()) AND (a.role = ANY (ARRAY['owner'::text, 'admin'::text])))))";

export const RESTRICTIVE_POLICIES: readonly PolicyEntry[] = [
  {
    name: 'app.api_keys.api_key_insert_creator',
    command: 'insert',
    roles: ['drefyn_app'],
    using: null,
    withCheck: KEY_CREATOR,
    reason:
      'a key is created only by the person acting, through their own owner or admin membership of its organization, never ownerless',
  },
  {
    name: 'app.invitations.invitation_insert_inviter',
    command: 'insert',
    roles: ['drefyn_app'],
    using: null,
    withCheck: INVITER_GRANTS_ROLE,
    reason:
      'acceptance trusts the invited role, so an invitation is sent only by the person acting and grants only what they could: an owner any role, an admin admin or member',
  },
  {
    name: 'app.invitations.invitation_update_inviter',
    command: 'update',
    roles: ['drefyn_app'],
    using: 'true',
    withCheck: INVITER_GRANTS_ROLE,
    reason: 'a resend or any other update cannot raise the role past what the inviter could grant',
  },
  {
    name: 'app.memberships.membership_delete_actor',
    command: 'delete',
    roles: ['drefyn_app'],
    using: `(${MEMBER_ACTOR} AND ((role <> 'owner'::text) OR ${OTHER_OWNER}))`,
    withCheck: null,
    reason:
      'only an owner removes an owner and only an owner or admin removes anyone, and never the last owner',
  },
  {
    name: 'app.memberships.membership_insert_origin',
    command: 'insert',
    roles: ['drefyn_app'],
    using: null,
    withCheck: MEMBERSHIP_ORIGIN,
    reason:
      'a membership is born only for the person acting, as the first owner of a new organization or from a live invitation with the same role; any other source needs its own arm',
  },
  {
    name: 'app.memberships.membership_update_actor',
    command: 'update',
    roles: ['drefyn_app'],
    using: MEMBER_ACTOR,
    withCheck: `(${MEMBER_ACTOR} AND ((role = 'owner'::text) OR ${OTHER_OWNER}))`,
    reason:
      'an owner sets any role; an admin never touches an owner row nor writes owner; a member changes nothing; no change leaves the organization without an owner',
  },
  {
    name: 'app.organizations.organization_insert_tier',
    command: 'insert',
    roles: ['drefyn_app'],
    using: null,
    withCheck: '((plan_tier = app.install_tier()) AND (read_only_since IS NULL))',
    reason:
      'a new organization starts on the install tier and writable; only billing changes either later',
  },
  {
    name: 'app.project_roles.project_role_delete_actor',
    command: 'delete',
    roles: ['drefyn_app'],
    using: PROJECT_ROLE_ACTOR,
    withCheck: null,
    reason: 'only an owner or admin, acting in person, takes a project role away',
  },
  {
    name: 'app.project_roles.project_role_insert_actor',
    command: 'insert',
    roles: ['drefyn_app'],
    using: null,
    withCheck: PROJECT_ROLE_ACTOR,
    reason: 'only an owner or admin, acting in person, grants a project role',
  },
  {
    name: 'app.project_roles.project_role_update_actor',
    command: 'update',
    roles: ['drefyn_app'],
    using: PROJECT_ROLE_ACTOR,
    withCheck: PROJECT_ROLE_ACTOR,
    reason: 'only an owner or admin, acting in person, changes a project role',
  },
];

export const GLOBAL_UNIQUE_CONSTRAINTS: readonly AllowEntry[] = [
  {
    name: 'app.organization_slugs.organization_slugs_slug_key',
    reason:
      'organization URL names are one public namespace; a taken slug is visible at creation and nothing else is',
  },
];

export const COLUMN_GRANT_TABLES: readonly AllowEntry[] = [
  {
    name: 'app.users',
    reason: 'a future column must not become readable by member_read or writable by self_update',
  },
  {
    name: 'app.password_credentials',
    reason: 'holds password hashes; each role gets exactly the columns its flows use',
  },
  {
    name: 'app.known_devices',
    reason: 'the auth role must never read a future column, nor the family it has no use for',
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
  restrictivePolicies: RESTRICTIVE_POLICIES,
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
  | 'cli_sign_in_links'
  | 'auth_rate_limits'
  | 'known_devices';
// The organization tables a user context reads, through the person's own memberships.
export type MemberTableName = 'memberships' | 'organizations' | 'organization_slugs';
export type UserTableName =
  'users' | 'identities' | 'sessions' | 'password_credentials' | 'known_devices' | MemberTableName;

// Identity tables organization scope never names. users stays, for the members page.
export type PersonalTableName =
  Exclude<AuthTableName | UserTableName, 'users' | MemberTableName> | 'api_key_failures';
