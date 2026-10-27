import type pg from 'pg';
import { ALLOW_LISTS, type AllowEntry, type AllowLists } from './allow-lists.ts';
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
  | 'role_setting';

export interface CatalogProblem {
  readonly rule: CatalogRule;
  // What is wrong, schema qualified: a table, table.column, function, sequence or role.
  readonly object: string;
  // One line naming the object and, for grants, the grantee.
  readonly message: string;
}

const APP_ROLE = POOL_ROLES.app;
const READER_ROLE = POOL_ROLES.reader;

const BOOKKEEPING = new Set([
  `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`,
  `${MIGRATIONS_SCHEMA}.${CHECKSUMS_TABLE}`,
  `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}_id_seq`,
]);

// pg_get_expr output for the helper's policies, read with search_path = pg_catalog so every
// name is schema qualified. Exact text on purpose: a semantic comparison would be a SQL
// analyser we would have to trust. A Postgres major upgrade reruns the catalog tests first.
const PROJECT_POLICY =
  '((organization_id = app.current_org()) AND ((app.current_project() IS NULL) OR (project_id = app.current_project())))';
const ORGANIZATION_POLICY = '(organization_id = app.current_org())';
const PUBLISHED_POLICY =
  '((organization_id = app.current_org()) AND (project_id = app.current_project()))';

const TABLE_NAME = /^app\.[a-z_][a-z0-9_]*$/;
const FUNCTION_NAME = /^app\.[a-z_][a-z0-9_]*\([^()]*\)$/;

const problem = (rule: CatalogRule, object: string, message: string): CatalogProblem => ({
  rule,
  object,
  message,
});

// Problems with the allow lists themselves: an empty reason or a duplicate entry.
export function allowListProblems(allow: AllowLists): readonly CatalogProblem[] {
  const lists: readonly [string, readonly AllowEntry[], RegExp][] = [
    ['global table', allow.globalTables, TABLE_NAME],
    ['SECURITY DEFINER function', allow.securityDefinerFunctions, FUNCTION_NAME],
    ['published table', allow.publishedTables, TABLE_NAME],
    ['reader function', allow.readerFunctions, FUNCTION_NAME],
  ];
  const problems: CatalogProblem[] = [];
  for (const [label, entries, shape] of lists) {
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
      if (seen.has(entry.name)) {
        problems.push(
          problem('allow_list', entry.name, `${label} entry ${entry.name} is listed twice`),
        );
      }
      seen.add(entry.name);
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

const RELATION_GRANTS = `
select n.nspname || '.' || c.relname as object, c.relkind::text as kind,
       null::text as column_name, ${GRANTEE} as grantee, a.privilege_type as privilege
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
 where n.nspname = 'app' and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
   and a.grantee <> c.relowner
union all
select n.nspname || '.' || c.relname, c.relkind::text, att.attname::text, ${GRANTEE}, a.privilege_type
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
 where r.rolname in ('${APP_ROLE}', '${READER_ROLE}') and cardinality(s.setconfig) > 0
 order by 1, 2 nulls first`;

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

function policyProblems(
  table: TableFacts,
  policies: readonly Policy[],
  published: boolean,
): CatalogProblem[] {
  const out: CatalogProblem[] = [];
  const expected = table.projectColumn === null ? ORGANIZATION_POLICY : PROJECT_POLICY;
  let isolated = false;
  // Restrictive policies can only narrow what the permissive ones let through.
  for (const policy of policies.filter((p) => p.permissive)) {
    if (policy.name === 'tenant_isolation') {
      const exact =
        policy.cmd === '*' &&
        sameRoles(policy.roles, APP_ROLE) &&
        policy.qual === expected &&
        policy.withCheck === expected;
      if (exact) {
        isolated = true;
        continue;
      }
      out.push(
        problem(
          'policy',
          table.name,
          `${table.name} policy tenant_isolation must be for all commands, to ${APP_ROLE} only, with the standard ${table.projectColumn === null ? 'organization' : 'project'} clause in using and with check (found to ${policy.roles.join(', ')})`,
        ),
      );
      continue;
    }
    if (policy.name === 'published_read') {
      const exact =
        policy.cmd === 'r' &&
        sameRoles(policy.roles, READER_ROLE) &&
        policy.qual === PUBLISHED_POLICY &&
        policy.withCheck === null;
      if (published && exact) continue;
      out.push(
        problem(
          'policy',
          table.name,
          published
            ? `${table.name} policy published_read must be for select, to ${READER_ROLE} only, needing both organization and project`
            : `${table.name} has a published_read policy but is not on the published table allow list`,
        ),
      );
      continue;
    }
    out.push(
      problem(
        'policy',
        table.name,
        `${table.name} has the extra permissive policy ${policy.name}; permissive policies are OR'd, so it can widen tenant_isolation`,
      ),
    );
  }
  const reported = policies.some((p) => p.permissive && p.name === 'tenant_isolation');
  if (!isolated && !reported) {
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
  for (const table of tables) {
    out.push(...tenantColumnProblems(table));
    out.push(
      ...policyProblems(table, policies.get(table.name) ?? [], publishedTables.has(table.name)),
    );
  }
  const tenantTables = new Set(tables.map((t) => t.name));
  // A global unique key would tell one tenant that a value exists in another through the
  // conflict. Ids are exempt because no insert path takes a client chosen id.
  for (const row of await rows(client, UNIQUE_INDEXES)) {
    const table = text(row, 'table_name');
    if (!tenantTables.has(table)) continue;
    const columns = texts(row, 'columns');
    if (columns.includes('organization_id')) continue;
    if (!flag(row, 'has_expressions') && columns.length === 1 && columns[0] === 'id') continue;
    const index = text(row, 'index_name');
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

async function grantProblems(client: pg.ClientBase, allow: AllowLists): Promise<CatalogProblem[]> {
  const out: CatalogProblem[] = [];
  const published = new Set(allow.publishedTables.map((e) => e.name));
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
    if (grantee !== READER_ROLE && grantee !== 'public') continue;
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
