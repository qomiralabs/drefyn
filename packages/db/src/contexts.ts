import type { AuthTableName, UserTableName } from './allow-lists.ts';
import type {
  AppPasswordCredentialsTable,
  AppUsersTable,
  AuthPasswordCredentialsTable,
  AuthUsersTable,
} from './identity-columns.ts';
import type { Schema } from './schema.generated.ts';

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

// The signed in person's own rows.
export type UserSchema = WithColumns<
  NamedTables<Schema, UserTableName>,
  AppUsersTable,
  AppPasswordCredentialsTable
>;

// The one table the API key failure limiter writes, before any key or organization is proved.
export type ApiKeyLimiterSchema = NamedTables<Schema, 'api_key_failures'>;
