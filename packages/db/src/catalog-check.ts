import type pg from 'pg';
import {
  ALLOW_LISTS,
  type AllowEntry,
  type AllowLists,
  type ColumnGrantEntry,
  type PolicyEntry,
} from './allow-lists.ts';
import { parseMigrationConfig } from './config.ts';
import {
  CHECKSUMS_TABLE,
  MIGRATION_ROLE,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
} from './constants.ts';
import { DbError } from './errors.ts';
import { toDbError } from './pg-errors.ts';
import { createClient } from './pg-session.ts';
import { describeRoleSetting, POOL_ROLES, unexpectedDatabaseSettings } from './role-check.ts';

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
  | 'role_setting'
  | 'app_privilege'
  | 'tenant_foreign_key'
  | 'auth_grant'
  | 'column_grant'
  | 'public_policy';

export interface CatalogProblem {
  readonly rule: CatalogRule;
  // What is wrong, schema qualified: a table, table.column, function, sequence or role.
  readonly object: string;
  // One line naming the object and, for grants, the grantee.
  readonly message: string;
}

const APP_ROLE = POOL_ROLES.app;
const READER_ROLE = POOL_ROLES.reader;
const AUTH_ROLE = POOL_ROLES.auth;

const BOOKKEEPING = new Set([
  `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`,
  `${MIGRATIONS_SCHEMA}.${CHECKSUMS_TABLE}`,
  `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}_id_seq`,
]);

// pg_get_expr output for the helper's policies, read with search_path = pg_catalog so every
// name is schema qualified. Exact text on purpose: a semantic comparison would be a SQL
// analyser we would have to trust. A Postgres major upgrade reruns the catalog tests first.
// A project table needs both settings, so organization scope reads none of its rows.
const PROJECT_POLICY =
  '((organization_id = app.current_org()) AND (project_id = app.current_project()))';
const ORGANIZATION_POLICY = '(organization_id = app.current_org())';
const PUBLISHED_POLICY =
  '((organization_id = app.current_org()) AND (project_id = app.current_project()))';

const TABLE_NAME = /^app\.[a-z_][a-z0-9_]*$/;
const FUNCTION_NAME = /^app\.[a-z_][a-z0-9_]*\([^()]*\)$/;
const CONSTRAINT_NAME = /^app\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

const problem = (rule: CatalogRule, object: string, message: string): CatalogProblem => ({
  rule,
  object,
  message,
});

const grantKey = (name: string, grantee: string, privilege: string) =>
  `${name}|${grantee}|${privilege}`;

interface ListSpec {
  readonly label: string;
  readonly entries: readonly AllowEntry[];
  readonly shape: RegExp;
  // What makes two entries the same; the name unless given.
  readonly key?: (entry: AllowEntry) => string;
  // A reason the entry itself is unsafe, if any.
  readonly unsafe?: (entry: AllowEntry) => string | undefined;
}

function policyUnsafe(entry: PolicyEntry): string | undefined {
  if (entry.roles.length === 0) return 'names no role';
  if (entry.roles.includes('public')) return 'is for public, which every role inherits';
  return undefined;
}

// Problems with the allow lists themselves: an empty reason, a bad name, a duplicate entry,
// or an entry that is unsafe whatever the catalog says.
export function allowListProblems(allow: AllowLists): readonly CatalogProblem[] {
  const lists: readonly ListSpec[] = [
    { label: 'global table', entries: allow.globalTables, shape: TABLE_NAME },
    {
      label: 'SECURITY DEFINER function',
      entries: allow.securityDefinerFunctions,
      shape: FUNCTION_NAME,
    },
    { label: 'published table', entries: allow.publishedTables, shape: TABLE_NAME },
    { label: 'reader function', entries: allow.readerFunctions, shape: FUNCTION_NAME },
    { label: 'app function', entries: allow.appFunctions, shape: FUNCTION_NAME },
    {
      label: 'cross project foreign key',
      entries: allow.crossProjectForeignKeys,
      shape: CONSTRAINT_NAME,
    },
    { label: 'auth table', entries: allow.authTables, shape: TABLE_NAME },
    {
      label: 'user policy',
      entries: allow.userPolicies,
      shape: CONSTRAINT_NAME,
      unsafe: (entry) => policyUnsafe(entry as PolicyEntry),
    },
    {
      label: 'global unique key',
      entries: allow.globalUniqueConstraints,
      shape: CONSTRAINT_NAME,
    },
    { label: 'column grant table', entries: allow.columnGrantTables, shape: TABLE_NAME },
    {
      label: 'column grant',
      entries: allow.columnGrants,
      shape: CONSTRAINT_NAME,
      key: (entry) => {
        const grant = entry as ColumnGrantEntry;
        return grantKey(grant.name, grant.grantee, grant.privilege);
      },
      unsafe: (entry) =>
        (entry as ColumnGrantEntry).grantee === 'public'
          ? 'is to public, which every role inherits'
          : undefined,
    },
  ];
  const problems: CatalogProblem[] = [];
  for (const { label, entries, shape, key, unsafe } of lists) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!shape.test(entry.name)) {
        problems.push(
          problem('allow_list', entry.name, `${label} entry ${entry.name} is not a name in app`),
        );
      }
      if (entry.reason.trim() === '') {
        problems.push(
          problem('allow_list', entry.name, `${label} entry ${entry.name} has no reason`),
        );
      }
      const id = key === undefined ? entry.name : key(entry);
      if (seen.has(id)) {
        problems.push(
          problem('allow_list', entry.name, `${label} entry ${entry.name} is listed twice`),
        );
      }
      seen.add(id);
      const why = unsafe?.(entry);
      if (why !== undefined) {
        problems.push(problem('allow_list', entry.name, `${label} entry ${entry.name} ${why}`));
      }
    }
  }
  return problems;
}

// Tables without organization_id that are not on the global table allow list.
export function globalTableProblems(
  tablesWithoutTenantColumn: readonly string[],
  allow: readonly AllowEntry[],
): readonly CatalogProblem[] {
  const allowed = new Set(allow.map((entry) => entry.name));
  return tablesWithoutTenantColumn
    .filter((table) => !allowed.has(table))
    .map((table) =>
      problem(
        'tenant_column',
        table,
        `${table} has no organization_id column and is not on the global table allow list`,
      ),
    );
}

type Row = Record<string, unknown>;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`catalog check: ${key} is not text`);
  return value;
}

function maybeText(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`catalog check: ${key} is not text`);
  return value;
}

function flag(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw new Error(`catalog check: ${key} is not a boolean`);
  return value;
}

function texts(row: Row, key: string): readonly string[] {
  const value = row[key];
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`catalog check: ${key} is not a text list`);
  }
  return value;
}

async function rows(client: pg.ClientBase, sql: string): Promise<readonly Row[]> {
  return (await client.query<Row>(sql)).rows;
}

const GRANTEE = `case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee)::text end`;

const TABLES = `
select c.oid::int8::text as oid, n.nspname || '.' || c.relname as name,
       c.relrowsecurity as rls, c.relforcerowsecurity as forced,
       (select format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
          from pg_attribute a where a.attrelid = c.oid and a.attname = 'organization_id'
           and a.attnum > 0 and not a.attisdropped) as organization_column,
       (select format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
          from pg_attribute a where a.attrelid = c.oid and a.attname = 'project_id'
           and a.attnum > 0 and not a.attisdropped) as project_column
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'app' and c.relkind in ('r', 'p')
 order by 2`;

const POLICIES = `
select n.nspname || '.' || c.relname as table_name, p.polname::text as name, p.polcmd::text as cmd,
       p.polpermissive as permissive,
       array(select case when r = 0 then 'public' else pg_get_userbyid(r)::text end
               from unnest(p.polroles) r order by 1) as roles,
       pg_get_expr(p.polqual, p.polrelid) as qual,
       pg_get_expr(p.polwithcheck, p.polrelid) as with_check
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'app'
 order by 1, 2`;

// Follows domains, arrays and ranges down to the base type, so wrapping a banned type in any
// of them does not hide it.
const BANNED_TYPES = `
with recursive cols(object, typ, depth) as (
  select n.nspname || '.' || c.relname || '.' || a.attname, a.atttypid, 0
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'app' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'c')
     and a.attnum > 0 and not a.attisdropped
  union all
  select cols.object,
         case when t.typtype = 'd' then t.typbasetype
              when t.typtype = 'r' then (select rngsubtype from pg_range where rngtypid = t.oid)
              when t.typtype = 'm' then (select rngsubtype from pg_range where rngmultitypid = t.oid)
              else t.typelem end,
         cols.depth + 1
    from cols join pg_type t on t.oid = cols.typ
   where cols.depth < 16
     and (t.typtype in ('d', 'r', 'm') or (t.typcategory = 'A' and t.typelem <> 0))
)
select distinct object, format_type(typ, null) as banned
  from cols
 where typ in ('pg_catalog.numeric'::regtype, 'pg_catalog.float4'::regtype,
               'pg_catalog.float8'::regtype, 'pg_catalog.money'::regtype,
               'pg_catalog.timestamp'::regtype)
 order by 1`;

const FUNCTION_NAME_SQL = `n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')'`;

const DEFINERS = `
select ${FUNCTION_NAME_SQL} as name
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app' and p.prosecdef
 order by 1`;

const VIEWS = `
select n.nspname || '.' || c.relname as name, c.relkind::text as kind,
       exists (select from unnest(coalesce(c.reloptions, '{}')) o
                where lower(o) in ('security_invoker=true', 'security_invoker=on',
                                   'security_invoker=yes', 'security_invoker=1')) as invoker
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'app' and c.relkind in ('v', 'm')
 order by 1`;

const UNIQUE_INDEXES = `
select n.nspname || '.' || t.relname as table_name, i.relname::text as index_name,
       array(select a.attname::text
               from unnest(x.indkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum
              where k.ord <= x.indnkeyatts
              order by k.ord) as columns,
       x.indexprs is not null as has_expressions
  from pg_index x
  join pg_class i on i.oid = x.indexrelid
  join pg_class t on t.oid = x.indrelid
  join pg_namespace n on n.oid = t.relnamespace
 where n.nspname = 'app' and x.indisunique
 order by 1, 2`;

const HAS_ORGANIZATION = `exists (select from pg_attribute o where o.attrelid = c.oid
                 and o.attname = 'organization_id' and o.attnum > 0 and not o.attisdropped)`;

const RELATION_GRANTS = `
select n.nspname || '.' || c.relname as object, c.relkind::text as kind,
       null::text as column_name, ${GRANTEE} as grantee, a.privilege_type as privilege,
       ${HAS_ORGANIZATION} as tenant
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
 where n.nspname = 'app' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
   and a.grantee <> c.relowner
union all
select n.nspname || '.' || c.relname, c.relkind::text, att.attname::text, ${GRANTEE}, a.privilege_type,
       ${HAS_ORGANIZATION}
  from pg_attribute att
  join pg_class c on c.oid = att.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(att.attacl) a
 where n.nspname = 'app' and att.attnum > 0 and not att.attisdropped and att.attacl is not null
   and a.grantee <> c.relowner
 order by 1, 3 nulls first, 4, 5`;

// A null proacl means the built in default, which lets PUBLIC execute.
const FUNCTION_GRANTS = `
select ${FUNCTION_NAME_SQL} as object, ${GRANTEE} as grantee, a.privilege_type as privilege
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
 where n.nspname = 'app' and a.grantee <> p.proowner
 order by 1, 2`;

const SCHEMA_GRANTS = `
select ${GRANTEE} as grantee, a.privilege_type as privilege
  from pg_namespace n
  cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
 where n.nspname = 'app' and a.grantee <> n.nspowner
 order by 1, 2`;

const DEFAULT_ACLS = `
select pg_get_userbyid(d.defaclrole)::text as role,
       coalesce(' in schema ' || n.nspname::text, '') as in_schema,
       case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences'
            when 'f' then 'functions' when 'T' then 'types' when 'n' then 'schemas'
            when 'L' then 'large objects' else 'objects of type ' || d.defaclobjtype::text end as what,
       ${GRANTEE} as grantee, a.privilege_type as privilege
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a
 order by 1, 2, 3, 4, 5`;

// Postgres deletes this row when it would equal the built in default, so its absence means
// PUBLIC executes every function the owner creates.
const EXECUTE_REVOKED = `
select exists (
  select from pg_default_acl d join pg_roles r on r.oid = d.defaclrole
   where r.rolname = '${MIGRATION_ROLE}' and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
     and not exists (select from aclexplode(d.defaclacl) a where a.grantee = 0)
) as revoked`;

const ROLE_SETTINGS = `
select r.rolname::text as role_name, d.datname::text as database_name, s.setconfig as settings
  from pg_db_role_setting s
  join pg_roles r on r.oid = s.setrole
  left join pg_database d on d.oid = s.setdatabase
 where r.rolname in ('${APP_ROLE}', '${READER_ROLE}', '${AUTH_ROLE}') and cardinality(s.setconfig) > 0
 order by 1, 2 nulls first`;

// alter role all set ...: no role and no database, so it follows every connection.
const CLUSTER_SETTINGS = `
select s.setconfig as settings from pg_db_role_setting s where s.setrole = 0 and s.setdatabase = 0`;

const DATABASE_SETTINGS = `
select current_database()::text as database_name,
       coalesce((select s.setconfig from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase
                  where s.setrole = 0 and d.datname = current_database()), '{}'::text[]) as settings`;

interface TableFacts {
  readonly name: string;
  // Type and nullability of organization_id, for example "uuid not null".
  readonly organizationColumn: string;
  readonly projectColumn: string | null;
}

function tenantColumnProblems(table: TableFacts): CatalogProblem[] {
  const out: CatalogProblem[] = [];
  if (table.organizationColumn !== 'uuid not null') {
    out.push(
      problem(
        'tenant_column',
        table.name,
        `${table.name}.organization_id must be uuid not null, found ${table.organizationColumn}`,
      ),
    );
  }
  if (table.projectColumn !== null && table.projectColumn !== 'uuid not null') {
    out.push(
      problem(
        'tenant_column',
        table.name,
        `${table.name}.project_id must be uuid not null, found ${table.projectColumn}`,
      ),
    );
  }
  return out;
}

interface Policy {
  readonly name: string;
  readonly cmd: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly qual: string | null;
  readonly withCheck: string | null;
}

const sameRoles = (roles: readonly string[], role: string) =>
  roles.length === 1 && roles[0] === role;

interface ExpectedPolicy {
  readonly cmd: string;
  readonly role: string;
  readonly qual: string;
  readonly withCheck: string | null;
}

const COMMANDS: Readonly<Record<string, string>> = {
  '*': 'all',
  r: 'select',
  a: 'insert',
  w: 'update',
  d: 'delete',
};

// Each part is compared on its own and named in the message: an exact USING with an open
// WITH CHECK would let drefyn_app write rows into another tenant.
function policyMismatches(policy: Policy, expected: ExpectedPolicy): string[] {
  const out: string[] = [];
  if (policy.cmd !== expected.cmd) {
    out.push(
      `is for ${COMMANDS[policy.cmd] ?? policy.cmd}, not ${COMMANDS[expected.cmd] ?? expected.cmd}`,
    );
  }
  if (!sameRoles(policy.roles, expected.role)) {
    out.push(`is to ${policy.roles.join(', ')}, not ${expected.role} only`);
  }
  if (policy.qual !== expected.qual) out.push('has a USING clause other than the standard one');
  if (policy.withCheck !== expected.withCheck) {
    out.push(
      expected.withCheck === null
        ? 'has a WITH CHECK clause'
        : 'has a WITH CHECK clause other than the standard one',
    );
  }
  return out;
}

const COMMAND_CODES: Readonly<Record<PolicyEntry['command'], string>> = {
  all: '*',
  select: 'r',
  insert: 'a',
  update: 'w',
  delete: 'd',
};

const sortedRoles = (roles: readonly string[]) => [...roles].sort().join(', ');

function entryMismatches(policy: Policy, entry: PolicyEntry): string[] {
  const out: string[] = [];
  if (policy.cmd !== COMMAND_CODES[entry.command]) {
    out.push(`is for ${COMMANDS[policy.cmd] ?? policy.cmd}, not ${entry.command}`);
  }
  if (sortedRoles(policy.roles) !== sortedRoles(entry.roles)) {
    out.push(`is to ${sortedRoles(policy.roles)}, not ${sortedRoles(entry.roles)}`);
  }
  if (policy.qual !== entry.using) out.push('has a USING clause other than its allow list entry');
  if (policy.withCheck !== entry.withCheck) {
    out.push('has a WITH CHECK clause other than its allow list entry');
  }
  return out;
}

// A permissive policy beyond the standard ones must match its reviewed entry exactly.
// Returns undefined when there is no entry, so the caller can say why it is not allowed.
function userPolicyProblem(
  table: string,
  policy: Policy,
  userPolicies: ReadonlyMap<string, PolicyEntry>,
): CatalogProblem | null | undefined {
  const entry = userPolicies.get(`${table}.${policy.name}`);
  if (entry === undefined) return undefined;
  const wrong = entryMismatches(policy, entry);
  if (wrong.length === 0) return null;
  return problem('policy', table, `${table} policy ${policy.name} ${wrong.join('; ')}`);
}

function globalPolicyProblems(
  table: string,
  policies: readonly Policy[],
  userPolicies: ReadonlyMap<string, PolicyEntry>,
): CatalogProblem[] {
  const out: CatalogProblem[] = [];
  for (const policy of policies.filter((p) => p.permissive)) {
    const listed = userPolicyProblem(table, policy, userPolicies);
    if (listed === null) continue;
    out.push(
      listed ??
        problem(
          'policy',
          table,
          `${table} has the permissive policy ${policy.name}, which is not on the user policy allow list`,
        ),
    );
  }
  return out;
}

function policyProblems(
  table: TableFacts,
  policies: readonly Policy[],
  published: boolean,
  userPolicies: ReadonlyMap<string, PolicyEntry>,
): CatalogProblem[] {
  const out: CatalogProblem[] = [];
  const clause = table.projectColumn === null ? ORGANIZATION_POLICY : PROJECT_POLICY;
  const isolation = { cmd: '*', role: APP_ROLE, qual: clause, withCheck: clause };
  const reading = { cmd: 'r', role: READER_ROLE, qual: PUBLISHED_POLICY, withCheck: null };
  // Restrictive policies can only narrow what the permissive ones let through.
  for (const policy of policies.filter((p) => p.permissive)) {
    if (policy.name !== 'tenant_isolation' && policy.name !== 'published_read') {
      const listed = userPolicyProblem(table.name, policy, userPolicies);
      if (listed === null) continue;
      out.push(
        listed ??
          problem(
            'policy',
            table.name,
            `${table.name} has the extra permissive policy ${policy.name}; permissive policies are OR'd, so it can widen tenant_isolation, and it is not on the user policy allow list`,
          ),
      );
      continue;
    }
    if (policy.name === 'published_read' && !published) {
      out.push(
        problem(
          'policy',
          table.name,
          `${table.name} has a published_read policy but is not on the published table allow list`,
        ),
      );
      continue;
    }
    const wrong = policyMismatches(
      policy,
      policy.name === 'tenant_isolation' ? isolation : reading,
    );
    if (wrong.length > 0) {
      out.push(
        problem('policy', table.name, `${table.name} policy ${policy.name} ${wrong.join('; ')}`),
      );
    }
  }
  if (!policies.some((p) => p.permissive && p.name === 'tenant_isolation')) {
    out.push(
      problem('policy', table.name, `${table.name} has no tenant_isolation policy to ${APP_ROLE}`),
    );
  }
  return out;
}

async function tableProblems(client: pg.ClientBase, allow: AllowLists): Promise<CatalogProblem[]> {
  const globals = new Set(allow.globalTables.map((e) => e.name));
  const publishedTables = new Set(allow.publishedTables.map((e) => e.name));
  const tables: TableFacts[] = [];
  const out: CatalogProblem[] = [];
  const withoutTenantColumn: string[] = [];
  const rlsByTable = new Map<string, { rls: boolean; forced: boolean }>();
  for (const row of await rows(client, TABLES)) {
    const name = text(row, 'name');
    const organizationColumn = maybeText(row, 'organization_column');
    rlsByTable.set(name, { rls: flag(row, 'rls'), forced: flag(row, 'forced') });
    if (organizationColumn === null) withoutTenantColumn.push(name);
    else tables.push({ name, organizationColumn, projectColumn: maybeText(row, 'project_column') });
  }
  out.push(...globalTableProblems(withoutTenantColumn, allow.globalTables));
  // Allow listed global tables hold no tenant rows; every other table needs forced RLS.
  for (const [name, state] of rlsByTable) {
    if (globals.has(name)) continue;
    if (!state.rls) {
      out.push(problem('rls_enabled', name, `${name} does not have row level security enabled`));
    }
    if (!state.forced) {
      out.push(problem('rls_forced', name, `${name} does not force row level security`));
    }
  }
  const policies = new Map<string, Policy[]>();
  for (const row of await rows(client, POLICIES)) {
    const table = text(row, 'table_name');
    const list = policies.get(table) ?? [];
    list.push({
      name: text(row, 'name'),
      cmd: text(row, 'cmd'),
      permissive: flag(row, 'permissive'),
      roles: texts(row, 'roles'),
      qual: maybeText(row, 'qual'),
      withCheck: maybeText(row, 'with_check'),
    });
    policies.set(table, list);
  }
  const userPolicies = new Map(allow.userPolicies.map((e) => [e.name, e]));
  for (const table of tables) {
    out.push(...tenantColumnProblems(table));
    out.push(
      ...policyProblems(
        table,
        policies.get(table.name) ?? [],
        publishedTables.has(table.name),
        userPolicies,
      ),
    );
  }
  for (const table of withoutTenantColumn) {
    out.push(...globalPolicyProblems(table, policies.get(table) ?? [], userPolicies));
  }
  // With no TO clause a policy applies to every role, the pools and the owner included, and
  // a restrictive one could be read as a guard it is not.
  for (const [table, list] of policies) {
    for (const policy of list.filter((p) => p.roles.includes('public'))) {
      out.push(
        problem(
          'public_policy',
          table,
          `${table} policy ${policy.name} applies to public, so every role gets it; name the role`,
        ),
      );
    }
  }
  const tenantTables = new Set(tables.map((t) => t.name));
  const globalUnique = new Set(allow.globalUniqueConstraints.map((e) => e.name));
  // A global unique key would tell one tenant that a value exists in another through the
  // conflict. Ids are exempt because no insert path takes a client chosen id.
  for (const row of await rows(client, UNIQUE_INDEXES)) {
    const table = text(row, 'table_name');
    if (!tenantTables.has(table)) continue;
    const columns = texts(row, 'columns');
    if (columns.includes('organization_id')) continue;
    if (!flag(row, 'has_expressions') && columns.length === 1 && columns[0] === 'id') continue;
    const index = text(row, 'index_name');
    if (globalUnique.has(`${table}.${index}`)) continue;
    out.push(
      problem('tenant_unique', table, `${table} has unique index ${index} without organization_id`),
    );
  }
  return out;
}

async function definitionProblems(
  client: pg.ClientBase,
  allow: AllowLists,
): Promise<CatalogProblem[]> {
  const out: CatalogProblem[] = [];
  for (const row of await rows(client, BANNED_TYPES)) {
    const object = text(row, 'object');
    const banned = text(row, 'banned');
    out.push(
      problem(
        'banned_type',
        object,
        `${object} is ${banned}; use bigint integer units or timestamptz`,
      ),
    );
  }
  const definers = new Set(allow.securityDefinerFunctions.map((e) => e.name));
  for (const row of await rows(client, DEFINERS)) {
    const name = text(row, 'name');
    if (definers.has(name)) continue;
    out.push(
      problem(
        'security_definer',
        name,
        `${name} is SECURITY DEFINER and not on the reviewed allow list`,
      ),
    );
  }
  for (const row of await rows(client, VIEWS)) {
    const name = text(row, 'name');
    if (text(row, 'kind') === 'm') {
      out.push(
        problem(
          'materialized_view',
          name,
          `${name} is a materialized view, which stores rows without row level security`,
        ),
      );
    } else if (!flag(row, 'invoker')) {
      out.push(
        problem(
          'view_security_invoker',
          name,
          `${name} runs with its owner's rights; create it with (security_invoker = true)`,
        ),
      );
    }
  }
  return out;
}

// The sign in role reaches only listed tables, and never one that holds tenant rows.
function authGrantProblem(
  target: string,
  object: string,
  privilege: string,
  tenant: boolean,
  authTables: ReadonlySet<string>,
): CatalogProblem | undefined {
  if (tenant) {
    return problem(
      'auth_grant',
      object,
      `${target} grants ${privilege} to ${AUTH_ROLE}; the sign in role may never reach a table with organization_id`,
    );
  }
  if (authTables.has(object)) return undefined;
  return problem(
    'auth_grant',
    object,
    `${target} grants ${privilege} to ${AUTH_ROLE} and ${object} is not on the auth table allow list`,
  );
}

const PER_COLUMN = new Set(['SELECT', 'UPDATE']);

// On the column controlled tables, select and update go per column and only as listed.
function columnGrantProblem(
  object: string,
  column: string | null,
  grantee: string,
  privilege: string,
  columnGrants: ReadonlySet<string>,
): CatalogProblem | undefined {
  if (column === null) {
    if (!PER_COLUMN.has(privilege)) return undefined;
    return problem(
      'column_grant',
      object,
      `${object} grants table level ${privilege} to ${grantee}; grant it per column, so a new column stays closed`,
    );
  }
  const target = `${object}.${column}`;
  if (columnGrants.has(grantKey(target, grantee, privilege))) return undefined;
  return problem(
    'column_grant',
    object,
    `${target} grants ${privilege} to ${grantee}, which is not on the column grant allow list`,
  );
}

async function grantProblems(client: pg.ClientBase, allow: AllowLists): Promise<CatalogProblem[]> {
  const out: CatalogProblem[] = [];
  const published = new Set(allow.publishedTables.map((e) => e.name));
  const authTables = new Set(allow.authTables.map((e) => e.name));
  const columnTables = new Set(allow.columnGrantTables.map((e) => e.name));
  const columnGrants = new Set(
    allow.columnGrants.map((e) => grantKey(e.name, e.grantee, e.privilege)),
  );
  for (const row of await rows(client, RELATION_GRANTS)) {
    const object = text(row, 'object');
    const column = maybeText(row, 'column_name');
    const grantee = text(row, 'grantee');
    const privilege = text(row, 'privilege');
    const target = column === null ? object : `${object}.${column}`;
    // The owner itself is left out by the query, so any grant here is one too many.
    if (BOOKKEEPING.has(object)) {
      out.push(
        problem(
          'bookkeeping_grant',
          object,
          `${target} grants ${privilege} to ${grantee}; only ${MIGRATION_ROLE} may touch it`,
        ),
      );
      continue;
    }
    if (grantee === AUTH_ROLE) {
      const found = authGrantProblem(target, object, privilege, flag(row, 'tenant'), authTables);
      if (found !== undefined) out.push(found);
    }
    if (columnTables.has(object)) {
      const found = columnGrantProblem(object, column, grantee, privilege, columnGrants);
      if (found !== undefined) out.push(found);
    }
    if (grantee !== READER_ROLE && grantee !== 'public') continue;
    const sequence = text(row, 'kind') === 'S';
    const allowed =
      grantee === READER_ROLE && !sequence && privilege === 'SELECT' && published.has(object);
    if (allowed) continue;
    out.push(
      problem(
        'reader_grant',
        object,
        `${target} grants ${privilege} to ${grantee}${grantee === 'public' ? ', which the reader inherits' : ''}; the reader may only select from tables on the published allow list`,
      ),
    );
  }
  const readerFunctions = new Set(allow.readerFunctions.map((e) => e.name));
  for (const row of await rows(client, FUNCTION_GRANTS)) {
    const object = text(row, 'object');
    const grantee = text(row, 'grantee');
    if (grantee === 'public') {
      out.push(
        problem(
          'public_execute',
          object,
          `${object} is executable by public, so every role can call it`,
        ),
      );
    } else if (grantee === AUTH_ROLE) {
      out.push(
        problem(
          'auth_grant',
          object,
          `${object} grants EXECUTE to ${AUTH_ROLE}; the sign in role runs no function in app`,
        ),
      );
    } else if (grantee === READER_ROLE && !readerFunctions.has(object)) {
      out.push(
        problem(
          'reader_grant',
          object,
          `${object} grants EXECUTE to ${READER_ROLE} and is not on the reader function allow list`,
        ),
      );
    }
  }
  for (const row of await rows(client, SCHEMA_GRANTS)) {
    const grantee = text(row, 'grantee');
    const privilege = text(row, 'privilege');
    const reader = grantee === READER_ROLE && privilege === 'USAGE';
    if (grantee === AUTH_ROLE && privilege !== 'USAGE') {
      out.push(
        problem(
          'auth_grant',
          MIGRATIONS_SCHEMA,
          `schema app grants ${privilege} to ${AUTH_ROLE}; the sign in role may only use it`,
        ),
      );
    }
    if (grantee === 'public' || (grantee === READER_ROLE && !reader)) {
      out.push(
        problem(
          'reader_grant',
          MIGRATIONS_SCHEMA,
          `schema app grants ${privilege} to ${grantee}; the reader may only use it`,
        ),
      );
    }
  }
  return out;
}

async function defaultPrivilegeProblems(client: pg.ClientBase): Promise<CatalogProblem[]> {
  const out: CatalogProblem[] = [];
  for (const row of await rows(client, DEFAULT_ACLS)) {
    const grantee = text(row, 'grantee');
    if (grantee !== READER_ROLE && grantee !== AUTH_ROLE && grantee !== 'public') continue;
    out.push(
      problem(
        'default_privileges',
        grantee,
        `default privileges for ${text(row, 'role')}${text(row, 'in_schema')} grant ${text(row, 'privilege')} on new ${text(row, 'what')} to ${grantee}; grants to it must be explicit`,
      ),
    );
  }
  const [revoked] = await rows(client, EXECUTE_REVOKED);
  if (revoked === undefined || !flag(revoked, 'revoked')) {
    out.push(
      problem(
        'default_privileges',
        'public',
        `public executes every function ${MIGRATION_ROLE} creates; the default EXECUTE grant to public must be revoked for all schemas`,
      ),
    );
  }
  return out;
}

async function settingProblems(client: pg.ClientBase): Promise<CatalogProblem[]> {
  const out: CatalogProblem[] = [];
  for (const row of await rows(client, ROLE_SETTINGS)) {
    const role = text(row, 'role_name');
    const description = describeRoleSetting({
      database: maybeText(row, 'database_name'),
      settings: texts(row, 'settings'),
    });
    out.push(
      problem(
        'role_setting',
        role,
        `${role} has the role setting ${description}, which follows every connection`,
      ),
    );
  }
  for (const row of await rows(client, CLUSTER_SETTINGS)) {
    for (const setting of texts(row, 'settings')) {
      out.push(
        problem(
          'role_setting',
          'all roles',
          `the setting ${setting} is set for all roles in every database, the pools included`,
        ),
      );
    }
  }
  for (const database of await rows(client, DATABASE_SETTINGS)) {
    const name = text(database, 'database_name');
    for (const setting of unexpectedDatabaseSettings(texts(database, 'settings'))) {
      out.push(
        problem(
          'role_setting',
          name,
          `database ${name} has the setting ${setting}, which applies to every connection`,
        ),
      );
    }
  }
  return out;
}

const APP_ROLE_OID = `(select oid from pg_roles where rolname = '${APP_ROLE}')`;

const APP_RELATION_GRANTS = `
select n.nspname || '.' || c.relname as object, c.relkind::text as kind, null::text as column_name,
       a.privilege_type as privilege, a.is_grantable as grantable
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
 where n.nspname = 'app' and a.grantee = ${APP_ROLE_OID}
union all
select n.nspname || '.' || c.relname, c.relkind::text, att.attname::text,
       a.privilege_type, a.is_grantable
  from pg_attribute att
  join pg_class c on c.oid = att.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(att.attacl) a
 where n.nspname = 'app' and att.attnum > 0 and not att.attisdropped and att.attacl is not null
   and a.grantee = ${APP_ROLE_OID}
 order by 1, 3 nulls first, 4`;

// has_*_privilege counts PUBLIC and role membership too, which is what drefyn_app can use.
const APP_REACH = `
select 'CREATE' as privilege, n.nspname::text as object from pg_namespace n
 where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
   and has_schema_privilege('${APP_ROLE}', n.oid, 'CREATE')
union all
select 'TEMP', current_database()::text
 where has_database_privilege('${APP_ROLE}', current_database(), 'TEMP')
union all
select 'OWNS', n.nspname || '.' || c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relowner = ${APP_ROLE_OID}
union all
select 'OWNS', n.nspname || '.' || p.proname || '()' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.proowner = ${APP_ROLE_OID}
union all
select 'OWNS', n.nspname::text from pg_namespace n where n.nspowner = ${APP_ROLE_OID}
union all
select 'OWNS', n.nspname || '.' || t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
 where t.typowner = ${APP_ROLE_OID} and t.typrelid = 0 and t.typelem = 0
union all
select 'EXECUTE', ${FUNCTION_NAME_SQL} from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'app' and has_function_privilege('${APP_ROLE}', p.oid, 'EXECUTE')
 order by 1, 2`;

const APP_DEFAULT_ACLS = `
select pg_get_userbyid(d.defaclrole)::text as role,
       coalesce(' in schema ' || n.nspname::text, '') as in_schema,
       d.defaclobjtype::text as objtype, a.privilege_type as privilege, a.is_grantable as grantable
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a
 where a.grantee = ${APP_ROLE_OID}
 order by 1, 2, 3, 4`;

// What drefyn_app may hold, by relation kind and by default privilege object type. TRUNCATE
// ignores row level security; REFERENCES, TRIGGER and MAINTAIN are owner business.
const TABLE_PRIVILEGES = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
const SEQUENCE_PRIVILEGES = new Set(['USAGE', 'SELECT']);
const DEFAULT_ALLOWED: Readonly<Record<string, ReadonlySet<string>>> = {
  r: TABLE_PRIVILEGES,
  S: SEQUENCE_PRIVILEGES,
};

async function appPrivilegeProblems(
  client: pg.ClientBase,
  allow: AllowLists,
): Promise<CatalogProblem[]> {
  const out: CatalogProblem[] = [];
  // One line per object and column, listing everything beyond what drefyn_app may hold.
  const beyond = new Map<
    string,
    { object: string; allowed: ReadonlySet<string>; extra: string[] }
  >();
  for (const row of await rows(client, APP_RELATION_GRANTS)) {
    const object = text(row, 'object');
    const column = maybeText(row, 'column_name');
    const privilege = text(row, 'privilege');
    const target = column === null ? object : `${object}.${column}`;
    const allowed = text(row, 'kind') === 'S' ? SEQUENCE_PRIVILEGES : TABLE_PRIVILEGES;
    if (flag(row, 'grantable')) {
      out.push(
        problem(
          'app_privilege',
          object,
          `${target} grants ${privilege} to ${APP_ROLE} with grant option`,
        ),
      );
    }
    if (allowed.has(privilege)) continue;
    const entry = beyond.get(target) ?? { object, allowed, extra: [] };
    entry.extra.push(privilege);
    beyond.set(target, entry);
  }
  for (const [target, { object, allowed, extra }] of beyond) {
    out.push(
      problem(
        'app_privilege',
        object,
        `${target} grants ${extra.join(', ')} to ${APP_ROLE}, beyond ${[...allowed].join(', ')}`,
      ),
    );
  }
  const functions = new Set(allow.appFunctions.map((e) => e.name));
  for (const row of await rows(client, APP_REACH)) {
    const privilege = text(row, 'privilege');
    const object = text(row, 'object');
    if (privilege === 'EXECUTE' && functions.has(object)) continue;
    const what: Readonly<Record<string, string>> = {
      CREATE: `${APP_ROLE} has CREATE on schema ${object}`,
      TEMP: `${APP_ROLE} has TEMP on database ${object}`,
      OWNS: `${APP_ROLE} owns ${object}`,
      EXECUTE: `${APP_ROLE} can execute ${object}, which is not on the app function allow list`,
    };
    out.push(
      problem('app_privilege', object, what[privilege] ?? `${APP_ROLE} ${privilege} ${object}`),
    );
  }
  for (const row of await rows(client, APP_DEFAULT_ACLS)) {
    const privilege = text(row, 'privilege');
    const allowed = DEFAULT_ALLOWED[text(row, 'objtype')];
    const grantable = flag(row, 'grantable');
    if (allowed?.has(privilege) === true && !grantable) continue;
    out.push(
      problem(
        'app_privilege',
        APP_ROLE,
        `default privileges for ${text(row, 'role')}${text(row, 'in_schema')} grant ${privilege}${grantable ? ' with grant option' : ''} on new objects of type ${text(row, 'objtype')} to ${APP_ROLE}`,
      ),
    );
  }
  return out;
}

const FOREIGN_KEYS = `
select n.nspname || '.' || c.relname as table_name, con.conname::text as name,
       rn.nspname || '.' || rc.relname as target,
       array(select a.attname::text from unnest(con.conkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
              order by k.ord) as columns,
       array(select a.attname::text from unnest(con.confkey) with ordinality as k(attnum, ord)
               join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum
              order by k.ord) as target_columns,
       exists (select from pg_attribute a where a.attrelid = con.confrelid and a.attname = 'organization_id'
                  and a.attnum > 0 and not a.attisdropped) as target_organization,
       exists (select from pg_attribute a where a.attrelid = con.confrelid and a.attname = 'project_id'
                  and a.attnum > 0 and not a.attisdropped) as target_project,
       exists (select from pg_attribute a where a.attrelid = con.conrelid and a.attname = 'project_id'
                  and a.attnum > 0 and not a.attisdropped) as source_project
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_class rc on rc.oid = con.confrelid
  join pg_namespace rn on rn.oid = rc.relnamespace
 where con.contype = 'f' and n.nspname = 'app'
 order by 1, 2`;

// Referential checks run with the owner's rights and ignore RLS, so a key on a bare id would
// let one tenant point at, and probe for, another tenant's row.
async function foreignKeyProblems(
  client: pg.ClientBase,
  allow: AllowLists,
): Promise<CatalogProblem[]> {
  const out: CatalogProblem[] = [];
  const crossProject = new Set(allow.crossProjectForeignKeys.map((e) => e.name));
  for (const row of await rows(client, FOREIGN_KEYS)) {
    if (!flag(row, 'target_organization')) continue;
    const table = text(row, 'table_name');
    const name = text(row, 'name');
    const columns = texts(row, 'columns');
    const targetColumns = texts(row, 'target_columns');
    const pairs = (column: string) =>
      targetColumns.some((target, i) => target === column && columns[i] === column);
    const missing: string[] = [];
    if (!pairs('organization_id')) missing.push('organization_id');
    const bothProjects = flag(row, 'target_project') && flag(row, 'source_project');
    if (bothProjects && !pairs('project_id') && !crossProject.has(`${table}.${name}`)) {
      missing.push('project_id');
    }
    if (missing.length === 0) continue;
    out.push(
      problem(
        'tenant_foreign_key',
        table,
        `${table} foreign key ${name} into ${text(row, 'target')} must include ${missing.join(' and ')} on both sides`,
      ),
    );
  }
  return out;
}

export async function checkCatalog(
  client: pg.ClientBase,
  allow: AllowLists = ALLOW_LISTS,
): Promise<readonly CatalogProblem[]> {
  const problems: CatalogProblem[] = [...allowListProblems(allow)];
  await client.query('begin read only');
  try {
    // Every name pg_get_expr and format_type print is then schema qualified, whatever the
    // database search_path says.
    await client.query('set local search_path = pg_catalog');
    problems.push(...(await tableProblems(client, allow)));
    problems.push(...(await definitionProblems(client, allow)));
    problems.push(...(await grantProblems(client, allow)));
    problems.push(...(await appPrivilegeProblems(client, allow)));
    problems.push(...(await foreignKeyProblems(client, allow)));
    problems.push(...(await defaultPrivilegeProblems(client)));
    problems.push(...(await settingProblems(client)));
  } finally {
    await client.query('rollback');
  }
  return problems;
}

export interface CheckCatalogIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
}

function describeError(error: unknown): string {
  const mapped = toDbError(error, 'DREFYN_MIGRATION_DATABASE_URL');
  return mapped instanceof DbError ? `${mapped.code}: ${mapped.message}` : String(mapped);
}

// Connects with DREFYN_MIGRATION_DATABASE_URL; exits 0 when clean, 1 with one line per problem.
export async function runCheckCatalog(io: CheckCatalogIo): Promise<number> {
  let client: pg.Client;
  try {
    client = createClient(parseMigrationConfig(io.env));
  } catch (error) {
    io.stderr.write(`check:catalog: ${describeError(error)}\n`);
    return 1;
  }
  client.on('error', () => undefined);
  try {
    await client.connect();
    const problems = await checkCatalog(client);
    if (problems.length === 0) {
      io.stdout.write('check:catalog: nothing in the catalog weakens tenant isolation\n');
      return 0;
    }
    for (const p of problems)
      io.stderr.write(`check:catalog: ${p.rule} ${p.object}: ${p.message}\n`);
    return 1;
  } catch (error) {
    io.stderr.write(`check:catalog: ${describeError(error)}\n`);
    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}
