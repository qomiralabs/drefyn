import type pg from 'pg';
import { DbError } from './errors.ts';

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

export const POOL_ROLES: Readonly<Record<PoolKind, string>> = {
  app: 'drefyn_app',
  reader: 'drefyn_public_reader',
};

// The bootstrap sets this one; any other database setting follows every connection.
export const BOOTSTRAP_DATABASE_SETTING = 'search_path=app, extensions';

export function describeRoleSetting(setting: RoleSetting): string {
  const where =
    setting.database === null ? 'for every database' : `in database ${setting.database}`;
  return `${setting.settings.join(', ')} ${where}`;
}

export function unexpectedDatabaseSettings(settings: readonly string[]): readonly string[] {
  return settings.filter((s) => s !== BOOTSTRAP_DATABASE_SETTING);
}

// One line per reason the connection is unsafe for this pool; empty when it is safe.
export function roleProblems(facts: RoleFacts, pool: PoolKind): readonly string[] {
  const user = facts.currentUser;
  const expected = POOL_ROLES[pool];
  const problems: string[] = [];
  if (user !== expected) {
    problems.push(`the ${pool} pool must connect as ${expected}, not ${user}`);
  }
  if (facts.superuser) problems.push(`${user} is a superuser, which ignores row level security`);
  if (facts.bypassRls) problems.push(`${user} has BYPASSRLS`);
  if (facts.ownedTables.length > 0) {
    problems.push(`${user} owns ${facts.ownedTables.join(', ')}, and an owner can turn RLS off`);
  }
  // NOINHERIT keeps a granted role's rights off by default, but SET ROLE still reaches them.
  for (const role of facts.memberOf) {
    problems.push(`${user} is a member of ${role}, so it can SET ROLE to it`);
  }
  for (const setting of facts.settings) {
    if (setting.settings.length === 0) continue;
    problems.push(`${user} has the role setting ${describeRoleSetting(setting)}`);
  }
  for (const setting of unexpectedDatabaseSettings(facts.databaseSettings)) {
    const tenant = setting.startsWith('drefyn.') ? ', which gives every connection a tenant' : '';
    problems.push(`the database setting ${setting} applies to every connection${tenant}`);
  }
  return problems;
}

// Throws DbError DB_ROLE_UNSAFE listing every problem.
export function assertRoleSafe(facts: RoleFacts, pool: PoolKind): void {
  const problems = roleProblems(facts, pool);
  if (problems.length > 0) {
    throw new DbError(
      'DB_ROLE_UNSAFE',
      `refusing to start the ${pool} pool: ${problems.join('; ')}`,
    );
  }
}

// Schema qualified throughout, because a role setting may have changed the search_path of
// the very connection being checked.
const ROLE_FACTS = `
select r.rolname::text as current_user_name,
       r.rolsuper as superuser,
       r.rolbypassrls as bypass_rls,
       array(select n.nspname::text || '.' || c.relname::text
               from pg_catalog.pg_class c
               join pg_catalog.pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'app' and c.relowner = r.oid and c.relkind <> 'i'
              order by 1) as owned_tables,
       array(select g.rolname::text
               from pg_catalog.pg_auth_members m
               join pg_catalog.pg_roles g on g.oid = m.roleid
              where m.member = r.oid
              order by 1) as member_of,
       array(select coalesce(d.datname::text, '') || '|' || array_to_string(s.setconfig, chr(31))
               from pg_catalog.pg_db_role_setting s
               left join pg_catalog.pg_database d on d.oid = s.setdatabase
              where s.setrole = r.oid
              order by 1) as role_settings,
       coalesce((select s.setconfig
                   from pg_catalog.pg_db_role_setting s
                   join pg_catalog.pg_database d on d.oid = s.setdatabase
                  where s.setrole = 0 and d.datname = pg_catalog.current_database()),
                '{}'::text[]) as database_settings
  from pg_catalog.pg_roles r
 where r.rolname = pg_catalog.current_user()`;

function strings(value: unknown, what: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    throw new Error(`role check: ${what} is not a list of strings`);
  }
  return value;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`role check: ${what} is not a boolean`);
  return value;
}

// "database|setting<US>setting", with an empty database for every database. The unit
// separator cannot appear in a setting, so the split is exact.
function parseRoleSetting(row: string): RoleSetting {
  const bar = row.indexOf('|');
  const database = row.slice(0, bar);
  const rest = row.slice(bar + 1);
  return {
    database: database === '' ? null : database,
    settings: rest === '' ? [] : rest.split('\u001f'),
  };
}

export async function readRoleFacts(client: pg.ClientBase): Promise<RoleFacts> {
  const { rows } = await client.query<Record<string, unknown>>(ROLE_FACTS);
  const row = rows[0];
  if (row === undefined) throw new Error('role check: current_user is not in pg_roles');
  const currentUser = row['current_user_name'];
  if (typeof currentUser !== 'string') throw new Error('role check: no current user');
  return {
    currentUser,
    superuser: bool(row['superuser'], 'superuser'),
    bypassRls: bool(row['bypass_rls'], 'bypass_rls'),
    ownedTables: strings(row['owned_tables'], 'owned_tables'),
    memberOf: strings(row['member_of'], 'member_of'),
    settings: strings(row['role_settings'], 'role_settings').map(parseRoleSetting),
    databaseSettings: strings(row['database_settings'], 'database_settings'),
  };
}
