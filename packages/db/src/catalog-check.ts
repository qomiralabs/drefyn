import type pg from 'pg';
import type { AllowEntry, AllowLists } from './allow-lists.ts';
import { notImplemented } from './not-implemented.ts';

export type CatalogRule =
  | 'allow_list'
  | 'tenant_column'
  | 'rls_enabled'
  | 'rls_forced'
  | 'policy'
  | 'banned_type'
  | 'security_definer'
  | 'view_security_invoker'
  | 'materialized_view'
  | 'tenant_unique'
  | 'reader_grant'
  | 'bookkeeping_grant'
  | 'public_execute'
  | 'default_privileges'
  | 'role_setting';

export interface CatalogProblem {
  readonly rule: CatalogRule;
  // What is wrong, schema qualified: a table, table.column, function, sequence or role.
  readonly object: string;
  // One line naming the object and, for grants, the grantee.
  readonly message: string;
}

// Problems with the allow lists themselves: an empty reason or a duplicate entry.
export function allowListProblems(allow: AllowLists): readonly CatalogProblem[] {
  return notImplemented(`allowListProblems(${typeof allow})`);
}

// Tables without organization_id that are not on the global table allow list.
export function globalTableProblems(
  tablesWithoutTenantColumn: readonly string[],
  allow: readonly AllowEntry[],
): readonly CatalogProblem[] {
  return notImplemented(
    `globalTableProblems(${String(tablesWithoutTenantColumn.length)}, ${String(allow.length)})`,
  );
}

export function checkCatalog(
  client: pg.ClientBase,
  allow?: AllowLists,
): Promise<readonly CatalogProblem[]> {
  return notImplemented(`checkCatalog(${typeof client}, ${typeof allow})`);
}

export interface CheckCatalogIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

// Connects with DREFYN_MIGRATION_DATABASE_URL; exits 0 when clean, 1 with one line per problem.
export function runCheckCatalog(io: CheckCatalogIo): Promise<number> {
  return notImplemented(`runCheckCatalog(${typeof io})`);
}
