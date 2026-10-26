import { notImplemented } from './not-implemented.ts';

export interface TenantTableSpec {
  // Table name in app, without the schema.
  readonly name: string;
  readonly scope: 'project' | 'organization';
  // Column definitions after the tenant columns, as SQL.
  readonly columns: readonly string[];
  // Extra table constraints, as SQL.
  readonly constraints?: readonly string[];
  // Columns after organization_id (and project_id) in the leading index.
  readonly indexColumns?: readonly string[];
  // The table the composite foreign key points at; app.projects unless given.
  readonly projectsTable?: string;
}

// The up section for a standard tenant table: tenant columns, the composite foreign key,
// the leading index, RLS enabled and forced, and the tenant_isolation policy.
export function tenantTableSql(spec: TenantTableSpec): string {
  return notImplemented(`tenantTableSql(${spec.name})`);
}

// A tenant table the public reader may select from, by an explicit grant and a policy that
// needs both organization and project context.
export function publishedTableSql(spec: Omit<TenantTableSpec, 'scope'>): string {
  return notImplemented(`publishedTableSql(${spec.name})`);
}
