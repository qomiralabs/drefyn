import type {
  ColumnType,
  FactorChallengesTable,
  KnownDevicesTable,
  PasswordCredentialsTable,
  RecoveryCodesTable,
  TotpCredentialsTable,
  UsersTable,
} from './schema.generated.ts';

// The column grants on users, password_credentials, known_devices and the second factor
// tables, written once. The catalog allow list
// and the transaction types are both built from this, so a type can never offer a column
// the role cannot touch, and the migration is held to the same list by check:catalog.

export type ColumnPrivilege = 'SELECT' | 'INSERT' | 'UPDATE';
export type ColumnGrantee = 'drefyn_app' | 'drefyn_auth';

interface RoleColumns<T> {
  readonly SELECT: readonly (keyof T & string)[];
  readonly INSERT: readonly (keyof T & string)[];
  readonly UPDATE: readonly (keyof T & string)[];
}

export const USER_COLUMNS = {
  drefyn_app: {
    SELECT: ['id', 'email', 'display_name', 'created_at'],
    INSERT: [],
    UPDATE: ['display_name', 'updated_at'],
  },
  drefyn_auth: {
    SELECT: [
      'id',
      'email',
      'email_normalized',
      'display_name',
      'email_verified_at',
      'created_at',
      'updated_at',
    ],
    INSERT: ['id', 'email', 'email_normalized', 'display_name', 'email_verified_at'],
    UPDATE: ['email', 'email_normalized', 'email_verified_at', 'updated_at'],
  },
} as const satisfies Record<ColumnGrantee, RoleColumns<UsersTable>>;

export const PASSWORD_CREDENTIAL_COLUMNS = {
  drefyn_app: {
    SELECT: ['user_id', 'phc', 'created_at', 'updated_at'],
    INSERT: ['user_id', 'phc'],
    UPDATE: ['phc', 'updated_at'],
  },
  drefyn_auth: {
    SELECT: ['user_id', 'phc'],
    INSERT: [],
    UPDATE: ['phc', 'updated_at'],
  },
} as const satisfies Record<ColumnGrantee, RoleColumns<PasswordCredentialsTable>>;

// The auth role only checks whether a device is known and deletes stale rows; it never reads
// the family or writes a row. It also selects ctid, which the type cannot name (see below).
export const KNOWN_DEVICE_COLUMNS = {
  drefyn_app: {
    SELECT: ['id', 'user_id', 'device_hash', 'user_agent_family', 'created_at', 'last_seen_at'],
    INSERT: ['user_id', 'device_hash', 'user_agent_family'],
    UPDATE: ['user_agent_family', 'last_seen_at'],
  },
  drefyn_auth: {
    SELECT: ['user_id', 'device_hash', 'last_seen_at'],
    INSERT: [],
    UPDATE: [],
  },
} as const satisfies Record<ColumnGrantee, RoleColumns<KnownDevicesTable>>;

// The second factor tables are the person's alone: the auth role holds nothing, and only the
// columns a verify or a spend moves are updatable.
const NO_AUTH = { SELECT: [], INSERT: [], UPDATE: [] } as const;

const TOTP_ALL = [
  'user_id',
  'key_id',
  'secret_nonce',
  'secret_sealed',
  'last_used_step',
  'failed_attempts',
  'confirmed_at',
  'last_used_at',
  'created_at',
  'updated_at',
] as const;

export const TOTP_CREDENTIAL_COLUMNS = {
  drefyn_app: {
    SELECT: TOTP_ALL,
    INSERT: TOTP_ALL,
    UPDATE: [
      'key_id',
      'secret_nonce',
      'secret_sealed',
      'last_used_step',
      'failed_attempts',
      'confirmed_at',
      'last_used_at',
      'updated_at',
    ],
  },
  drefyn_auth: NO_AUTH,
} as const satisfies Record<ColumnGrantee, RoleColumns<TotpCredentialsTable>>;

const RECOVERY_ALL = ['id', 'user_id', 'code_hash', 'used_at', 'created_at'] as const;

export const RECOVERY_CODE_COLUMNS = {
  drefyn_app: { SELECT: RECOVERY_ALL, INSERT: RECOVERY_ALL, UPDATE: ['used_at'] },
  drefyn_auth: NO_AUTH,
} as const satisfies Record<ColumnGrantee, RoleColumns<RecoveryCodesTable>>;

const CHALLENGE_ALL = [
  'user_id',
  'secret_hash',
  'method',
  'return_to',
  'attempts',
  'expires_at',
  'created_at',
] as const;

// Only attempts moves, so a new challenge is a delete then an insert and a racing second
// insert fails on the key.
export const FACTOR_CHALLENGE_COLUMNS = {
  drefyn_app: { SELECT: CHALLENGE_ALL, INSERT: CHALLENGE_ALL, UPDATE: ['attempts'] },
  drefyn_auth: NO_AUTH,
} as const satisfies Record<ColumnGrantee, RoleColumns<FactorChallengesTable>>;

type SelectOf<C> = C extends ColumnType<infer S, unknown, unknown> ? S : C;
type InsertOf<C> = C extends ColumnType<unknown, infer I, unknown> ? I : C;
type UpdateOf<C> = C extends ColumnType<unknown, unknown, infer U> ? U : C;

type Listed<L, K> = L extends readonly (infer E)[] ? (K extends E ? true : false) : false;

// A table type with only the granted columns, each readable, insertable and updatable only
// as granted. A column with no grant at all is not a key, so naming it does not compile.
export type GrantedColumns<T, G extends RoleColumns<T>> = {
  [K in G['SELECT'][number] | G['INSERT'][number] | G['UPDATE'][number]]: ColumnType<
    Listed<G['SELECT'], K> extends true ? SelectOf<T[K]> : never,
    Listed<G['INSERT'], K> extends true ? InsertOf<T[K]> : never,
    Listed<G['UPDATE'], K> extends true ? UpdateOf<T[K]> : never
  >;
};

export type AppUsersTable = GrantedColumns<UsersTable, (typeof USER_COLUMNS)['drefyn_app']>;
export type AuthUsersTable = GrantedColumns<UsersTable, (typeof USER_COLUMNS)['drefyn_auth']>;
export type AppPasswordCredentialsTable = GrantedColumns<
  PasswordCredentialsTable,
  (typeof PASSWORD_CREDENTIAL_COLUMNS)['drefyn_app']
>;
export type AuthPasswordCredentialsTable = GrantedColumns<
  PasswordCredentialsTable,
  (typeof PASSWORD_CREDENTIAL_COLUMNS)['drefyn_auth']
>;

export type AppKnownDevicesTable = GrantedColumns<
  KnownDevicesTable,
  (typeof KNOWN_DEVICE_COLUMNS)['drefyn_app']
>;
export type AuthKnownDevicesTable = GrantedColumns<
  KnownDevicesTable,
  (typeof KNOWN_DEVICE_COLUMNS)['drefyn_auth']
>;

export type AppTotpCredentialsTable = GrantedColumns<
  TotpCredentialsTable,
  (typeof TOTP_CREDENTIAL_COLUMNS)['drefyn_app']
>;
export type AppRecoveryCodesTable = GrantedColumns<
  RecoveryCodesTable,
  (typeof RECOVERY_CODE_COLUMNS)['drefyn_app']
>;
export type AppFactorChallengesTable = GrantedColumns<
  FactorChallengesTable,
  (typeof FACTOR_CHALLENGE_COLUMNS)['drefyn_app']
>;

export interface ColumnGrant {
  readonly name: string;
  readonly grantee: ColumnGrantee;
  readonly privilege: ColumnPrivilege;
}

const PRIVILEGES: readonly ColumnPrivilege[] = ['SELECT', 'INSERT', 'UPDATE'];

function grantsOn(
  table: string,
  byRole: Readonly<Record<ColumnGrantee, Readonly<Record<ColumnPrivilege, readonly string[]>>>>,
): ColumnGrant[] {
  const out: ColumnGrant[] = [];
  for (const grantee of ['drefyn_app', 'drefyn_auth'] as const) {
    for (const privilege of PRIVILEGES) {
      for (const column of byRole[grantee][privilege]) {
        out.push({ name: `app.${table}.${column}`, grantee, privilege });
      }
    }
  }
  return out;
}

export const IDENTITY_COLUMN_GRANTS: readonly ColumnGrant[] = [
  ...grantsOn('users', USER_COLUMNS),
  ...grantsOn('password_credentials', PASSWORD_CREDENTIAL_COLUMNS),
  ...grantsOn('known_devices', KNOWN_DEVICE_COLUMNS),
  ...grantsOn('totp_credentials', TOTP_CREDENTIAL_COLUMNS),
  ...grantsOn('recovery_codes', RECOVERY_CODE_COLUMNS),
  ...grantsOn('factor_challenges', FACTOR_CHALLENGE_COLUMNS),
  // The expiry cleanup deletes in batches by ctid, so the auth role selects that system column.
  { name: 'app.known_devices.ctid', grantee: 'drefyn_auth', privilege: 'SELECT' },
];
