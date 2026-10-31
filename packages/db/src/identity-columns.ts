import type { ColumnType, PasswordCredentialsTable, UsersTable } from './schema.generated.ts';

// The column grants on users and password_credentials, written once. The catalog allow list
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
];
