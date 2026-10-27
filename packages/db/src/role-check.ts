import type pg from 'pg';
import { notImplemented } from './not-implemented.ts';

export type PoolKind = 'app' | 'reader';

export interface RoleSetting {
  // The database the setting applies to, or null for every database.
  readonly database: string | null;
  readonly settings: readonly string[];
}

export interface RoleFacts {
  readonly currentUser: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
  // Tables in app the current user owns, schema qualified.
  readonly ownedTables: readonly string[];
  // Roles the current user is a member of.
  readonly memberOf: readonly string[];
  // pg_roles.rolconfig plus every pg_db_role_setting row for the role.
  readonly settings: readonly RoleSetting[];
  // Database wide pg_db_role_setting entries (setrole = 0) for the current database.
  readonly databaseSettings: readonly string[];
}

// One line per reason the connection is unsafe for this pool; empty when it is safe.
export function roleProblems(facts: RoleFacts, pool: PoolKind): readonly string[] {
  return notImplemented(`roleProblems(${typeof facts}, ${pool})`);
}

// Throws DbError DB_ROLE_UNSAFE listing every problem.
export function assertRoleSafe(facts: RoleFacts, pool: PoolKind): void {
  notImplemented(`assertRoleSafe(${typeof facts}, ${pool})`);
}

export function readRoleFacts(client: pg.ClientBase): Promise<RoleFacts> {
  return notImplemented(`readRoleFacts(${typeof client})`);
}
