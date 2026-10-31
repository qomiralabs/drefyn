import type { AuthTableName, MemberTableName, UserTableName } from './allow-lists.ts';
import type {
  AppPasswordCredentialsTable,
  AppUsersTable,
  AuthPasswordCredentialsTable,
  AuthUsersTable,
} from './identity-columns.ts';
import type { ColumnType, Schema } from './schema.generated.ts';

// Only the named tables, so a table outside the list is not even a name the transaction can
// type.
export type NamedTables<S, T extends string> = { [K in keyof S & T]: S[K] };

// The column controlled tables, swapped for the columns the role was granted.
type WithColumns<S, Users, Credentials> = Omit<S, 'users' | 'password_credentials'> & {
  users: Users;
  password_credentials: Credentials;
};

// The identity tables drefyn_auth may touch, before anyone is signed in.
export type AuthSchema = WithColumns<
  NamedTables<Schema, AuthTableName>,
  AuthUsersTable,
  AuthPasswordCredentialsTable
>;

type SelectOf<C> = C extends ColumnType<infer S, unknown, unknown> ? S : C;

// Every column readable and none insertable or updatable. The policies already refuse the
// write; this keeps it from compiling.
export type ReadOnlyTable<T> = { [K in keyof T]: ColumnType<SelectOf<T[K]>, never, never> };

type ReadOnlyTables<S, T extends string> = Omit<S, T> & {
  [K in keyof S & T]: ReadOnlyTable<S[K]>;
};

// The signed in person's own rows, and the organizations they belong to, read only.
export type UserSchema = ReadOnlyTables<
  WithColumns<NamedTables<Schema, UserTableName>, AppUsersTable, AppPasswordCredentialsTable>,
  MemberTableName
>;

// The one table the API key failure limiter writes, before any key or organization is proved.
export type ApiKeyLimiterSchema = NamedTables<Schema, 'api_key_failures'>;
