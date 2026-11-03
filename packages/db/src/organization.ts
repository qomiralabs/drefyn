import type { PersonalTableName } from './allow-lists.ts';
import type { AppUsersTable } from './identity-columns.ts';
import type {
  ApiKeyProjectsTable,
  ApiKeysTable,
  ColumnType,
  InvitationBlocksTable,
  InvitationsTable,
  MembershipsTable,
  OrganizationsTable,
  ProjectsTable,
  Schema,
} from './schema.generated.ts';

// Tables with no project_id column, so organization scope cannot even name a project table.
export type OrganizationView<S> = {
  [K in keyof S as 'project_id' extends keyof S[K] ? never : K]: S[K];
};

type SelectOf<C> = C extends ColumnType<infer S, unknown, unknown> ? S : C;
type InsertOf<C> = C extends ColumnType<unknown, infer I, unknown> ? I : C;
type UpdateOf<C> = C extends ColumnType<unknown, unknown, infer U> ? U : C;

// Every column insertable as generated, and updatable only when listed: the same columns the
// migration grants drefyn_app update on, so a write the grant refuses does not compile.
type UpdatableOnly<T, K extends keyof T> = {
  [C in keyof T]: ColumnType<SelectOf<T[C]>, InsertOf<T[C]>, C extends K ? UpdateOf<T[C]> : never>;
};

// Plan, read only state, roles and everything about an API key but its use time are set at
// creation; organization work cannot change them. A resend rewrites an invitation in place but
// never its address; a block is never edited.
type GrantedTables<S> = Omit<
  S,
  | 'organizations'
  | 'memberships'
  | 'projects'
  | 'invitations'
  | 'invitation_blocks'
  | 'api_keys'
  | 'api_key_projects'
> & {
  organizations: UpdatableOnly<OrganizationsTable, 'name' | 'updated_at'>;
  memberships: UpdatableOnly<MembershipsTable, 'default_project_role' | 'updated_at'>;
  projects: UpdatableOnly<ProjectsTable, 'slug' | 'name' | 'updated_at'>;
  api_keys: UpdatableOnly<ApiKeysTable, 'last_used_at'>;
  api_key_projects: UpdatableOnly<ApiKeyProjectsTable, never>;
  invitations: UpdatableOnly<
    InvitationsTable,
    | 'role'
    | 'default_project_role'
    | 'secret_hash'
    | 'invited_by'
    | 'send_count'
    | 'expires_at'
    | 'updated_at'
  >;
  invitation_blocks: UpdatableOnly<InvitationBlocksTable, never>;
};

// Key hashes are organization work. A project path runs with an attacker supplied tenant, so
// it never names them.
type ApiKeyTableName = 'api_keys' | 'api_key_projects';

// The identity and limiter tables belong to a person or to sign in, never to an
// organization. users stays, with drefyn_app's granted columns, for the members page.
export type OrganizationSchema = OrganizationView<
  GrantedTables<Omit<Schema, PersonalTableName | 'users'>>
> & {
  users: AppUsersTable;
};

// Project work: the project and organization tables, never an identity or limiter table. A
// project path runs with an attacker supplied tenant, so it must not even name the API key
// throttle or anyone's address.
export type TenantSchema = Omit<
  GrantedTables<Omit<Schema, PersonalTableName | 'users'>>,
  ApiKeyTableName
>;
