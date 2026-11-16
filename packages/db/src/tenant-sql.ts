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

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const HELPER_COLUMNS = /^\s*"?(id|organization_id|project_id)"?(\s|$)/i;

function identifier(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`${what} must be a lower case, unquoted name of up to 63 bytes`);
  }
  return value;
}

// Policies are to drefyn_app only: on PUBLIC they would also apply to the reader and the
// owner, and permissive policies are OR'd. A project table needs both settings, so
// organization scope reads none of its rows.
export function tenantPredicate(scope: 'project' | 'organization'): string {
  return scope === 'project'
    ? 'organization_id = app.current_org() and project_id = app.current_project()'
    : 'organization_id = app.current_org()';
}

// The up section for a standard tenant table: tenant columns, the composite foreign key,
// the leading index, RLS enabled and forced, and the tenant_isolation policy.
export function tenantTableSql(spec: TenantTableSpec): string {
  const name = identifier(spec.name, 'table name');
  // Checked at run time too: a migration written in plain JavaScript is not typechecked.
  const scope = spec.scope as string;
  if (scope !== 'project' && scope !== 'organization') {
    throw new Error(`unknown scope ${scope} for table ${name}`);
  }
  const projects = identifier(spec.projectsTable ?? 'projects', 'projects table');
  for (const column of spec.columns) {
    if (HELPER_COLUMNS.test(column)) {
      throw new Error(`column "${column}" is one the helper adds itself`);
    }
  }
  const table = `app.${name}`;
  const project = scope === 'project';
  const lines = [
    'id uuid primary key default uuidv7()',
    'organization_id uuid not null',
    ...(project ? ['project_id uuid not null'] : []),
    ...spec.columns,
    'created_at timestamptz not null default now()',
    'updated_at timestamptz not null default now()',
    ...(spec.constraints ?? []),
    ...(project
      ? [
          `foreign key (organization_id, project_id) references app.${projects} (organization_id, id)`,
        ]
      : []),
  ];
  const indexColumns = [
    'organization_id',
    ...(project ? ['project_id'] : []),
    ...(spec.indexColumns ?? []),
  ];
  const predicate = tenantPredicate(scope);
  return `create table ${table} (
  ${lines.join(',\n  ')}
);
create index on ${table} (${indexColumns.join(', ')});
alter table ${table} enable row level security;
alter table ${table} force row level security;
create policy tenant_isolation on ${table} to drefyn_app
  using (${predicate})
  with check (${predicate});`;
}

// A tenant table both readers may select from, by explicit grants and policies that need
// both organization and project context. Every row says whether it is public or protected,
// with no default, and a restrictive policy keeps the public reader to public rows: permissive
// policies are OR'd, so only a restrictive one can narrow published_read.
export function publishedTableSql(spec: Omit<TenantTableSpec, 'scope'>): string {
  const table = `app.${identifier(spec.name, 'table name')}`;
  const predicate = tenantPredicate('project');
  const columns = [
    ...spec.columns,
    "visibility text not null check (visibility in ('public', 'protected'))",
  ];
  return `${tenantTableSql({ ...spec, columns, scope: 'project' })}
grant select on ${table} to drefyn_public_reader;
create policy published_read on ${table} for select to drefyn_public_reader
  using (${predicate});
create policy published_public_only on ${table} as restrictive for select to drefyn_public_reader
  using (visibility = 'public');
grant select on ${table} to drefyn_protected_reader;
create policy protected_read on ${table} for select to drefyn_protected_reader
  using (${predicate});`;
}
