import type { AuthTableName, MemberTableName, UserTableName } from './allow-lists.ts';
import type {
  AppFactorChallengesTable,
  AppKnownDevicesTable,
  AppPasswordCredentialsTable,
  AppRecoveryCodesTable,
  AppTotpCredentialsTable,
  AppUsersTable,
  AuthKnownDevicesTable,
  AuthPasswordCredentialsTable,
  AuthUsersTable,
} from './identity-columns.ts';
import type { ApiKeysTable, ColumnType, Schema, SsoIdentitiesTable } from './schema.generated.ts';
import type {
  AuthSsoConnectionsTable,
  AuthSsoDomainsTable,
  AuthSsoIdentitiesTable,
  AuthSsoStatesTable,
} from './sso-columns.ts';

// Only the named tables, so a table outside the list is not even a name the transaction can
// type.
export type NamedTables<S, T extends string> = { [K in keyof S & T]: S[K] };

// The column controlled tables, swapped for the columns the role was granted.
type WithColumns<S, Users, Credentials, Devices> = Omit<
  S,
  'users' | 'password_credentials' | 'known_devices'
> & {
  users: Users;
  password_credentials: Credentials;
  known_devices: Devices;
};

type SelectOf<C> = C extends ColumnType<infer S, unknown, unknown> ? S : C;

// The cleanup finds old revoked keys by one column and reports them by another. Kept apart
// from AuthTableName, which also decides what organization work may not name, and this table
// is its to name.
interface AuthApiKeysTable {
  revoked_at: ColumnType<SelectOf<ApiKeysTable['revoked_at']>, never, never>;
  organization_id: ColumnType<SelectOf<ApiKeysTable['organization_id']>, never, never>;
}

// The identity tables drefyn_auth may touch, before anyone is signed in.
export type AuthSchema = WithColumns<
  NamedTables<Schema, AuthTableName>,
  AuthUsersTable,
  AuthPasswordCredentialsTable,
  AuthKnownDevicesTable
> & {
  api_keys: AuthApiKeysTable;
  // Tenant tables the sign in role reaches by column, kept apart from AuthTableName for the
  // same reason as api_keys.
  sso_connections: AuthSsoConnectionsTable;
  sso_domains: AuthSsoDomainsTable;
  sso_identities: AuthSsoIdentitiesTable;
  sso_states: AuthSsoStatesTable;
};

// Every column readable and none insertable or updatable. The policies already refuse the
// write; this keeps it from compiling.
export type ReadOnlyTable<T> = { [K in keyof T]: ColumnType<SelectOf<T[K]>, never, never> };

type ReadOnlyTables<S, T extends string> = Omit<S, T> & {
  [K in keyof S & T]: ReadOnlyTable<S[K]>;
};

// The second factor tables, swapped for their granted columns. Only the user context names
// them, so this applies to UserSchema alone.
type WithFactorColumns<S> = Omit<S, 'totp_credentials' | 'recovery_codes' | 'factor_challenges'> & {
  totp_credentials: AppTotpCredentialsTable;
  recovery_codes: AppRecoveryCodesTable;
  factor_challenges: AppFactorChallengesTable;
};

// The signed in person's own rows, and the organizations they belong to, read only. Their
// SSO links are read only too: only sign in writes one.
export type UserSchema = ReadOnlyTables<
  WithFactorColumns<
    WithColumns<
      NamedTables<Schema, UserTableName>,
      AppUsersTable,
      AppPasswordCredentialsTable,
      AppKnownDevicesTable
    >
  >,
  MemberTableName
> & { sso_identities: ReadOnlyTable<SsoIdentitiesTable> };

// The one table the API key failure limiter writes, before any key or organization is proved.
export type ApiKeyLimiterSchema = NamedTables<Schema, 'api_key_failures'>;

// The one table the GitHub webhook receiver writes, before it knows any tenant.
export type WebhookLedgerSchema = NamedTables<Schema, 'github_webhook_deliveries'>;
