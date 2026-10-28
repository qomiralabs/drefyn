import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UPGRADE_ROLES } from '../src/prerequisites.ts';
import { POOL_ROLES } from '../src/role-check.ts';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const postgres = join(repoRoot, 'deploy', 'postgres');
const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

// Comments may mention what the code must never do, so every rule reads code only.
const code = (sql: string) =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

const upgradeDir = join(postgres, 'upgrade');
const upgradeFiles = readdirSync(upgradeDir).filter((f) => f.endsWith('.sql'));
const upgrade = code(read(upgradeDir, '0001-auth-role.sql'));
const quiet = code(read(postgres, 'quiet-log.sql'));
const bootstrap = code(read(postgres, 'bootstrap.sql'));

// psql never substitutes variables inside a dollar quoted body, so a DO block that sets a
// password must carry it as literal text, which the server log and pg_stat_statements keep.
const DO_BLOCK = /(^|[\s;])do\s*(\$|'|language\b)/im;
const DOLLAR_QUOTE = /\$[A-Za-z_]*\$/;
const ROLE_SETTING = /\balter\s+(role|user)\b[^;]*\bset\b/i;

const ATTRIBUTES = 'login nosuperuser nobypassrls nocreaterole nocreatedb noinherit';

function createRole(sql: string, role: string): string {
  const match = new RegExp(`create role ${role}\\b([^;]*);`, 'i').exec(sql);
  expect(match, `create role ${role}`).not.toBeNull();
  return (match?.[1] ?? '').replace(/\s+/g, ' ').trim();
}

describe('the upgrade scripts', () => {
  it('ship one numbered file per upgrade role', () => {
    expect(upgradeFiles).toEqual(['0001-auth-role.sql']);
    for (const { script } of UPGRADE_ROLES) {
      expect(read(repoRoot, script).length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['the upgrade script', upgrade],
    ['the shared quiet log include', quiet],
  ])('%s has no DO block and no dollar quoting', (_name, sql) => {
    expect(sql).not.toMatch(DO_BLOCK);
    expect(sql).not.toMatch(DOLLAR_QUOTE);
  });

  it.each([
    ['the upgrade script', upgrade],
    ['the shared quiet log include', quiet],
    ['the bootstrap', bootstrap],
  ])('%s sets nothing on a role', (_name, sql) => {
    expect(sql).not.toMatch(ROLE_SETTING);
  });

  it('stops on the first error and runs the quiet include before it reads the password', () => {
    const stop = upgrade.indexOf('\\set ON_ERROR_STOP on');
    const include = upgrade.indexOf('\\ir ../quiet-log.sql');
    const sentinel = upgrade.indexOf(':{?drefyn_log_quiet}');
    const getenv = upgrade.indexOf('\\getenv auth_password DREFYN_AUTH_PASSWORD');
    const create = upgrade.search(/create role drefyn_auth/i);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(include);
    expect(include).toBeLessThan(sentinel);
    expect(sentinel).toBeLessThan(getenv);
    expect(getenv).toBeLessThan(create);
  });

  it('checks for the role with gset and if, then runs a plain create role', () => {
    expect(upgrade).toMatch(
      /select not exists \(\s*select from pg_catalog\.pg_roles where rolname = 'drefyn_auth'\s*\) as need \\gset/,
    );
    expect(upgrade).toMatch(/\\if :need\b/);
    expect(createRole(upgrade, 'drefyn_auth')).toBe(`${ATTRIBUTES} password :'auth_password'`);
    expect(upgrade).toMatch(/grant connect on database :"dbname" to drefyn_auth;/);
  });

  it('only ever uses the password as a quoted psql variable', () => {
    const uses = upgrade.match(/:'?"?auth_password'?"?/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toBe(":'auth_password'");
    expect(upgrade).toMatch(/\\unset auth_password/);
  });

  it('checks every attribute of an existing role instead of skipping it', () => {
    for (const column of [
      'rolcanlogin',
      'rolsuper',
      'rolbypassrls',
      'rolcreaterole',
      'rolcreatedb',
      'rolinherit',
      'rolreplication',
      'rolconfig',
      'pg_db_role_setting',
      'pg_auth_members',
    ]) {
      expect(upgrade, column).toContain(column);
    }
    expect(upgrade).toMatch(
      /as attributes_ok\s+from pg_catalog\.pg_roles r where rolname = 'drefyn_auth' \\gset/,
    );
    expect(upgrade).toMatch(/\\if :attributes_ok/);
    // One rule: the verdict is derived from the list it prints, so the two cannot drift.
    expect(upgrade).toMatch(/differences = '' as attributes_ok/);
    expect(upgrade.match(/\bnot rolinherit\b/g) ?? []).toEqual([]);
  });
});

describe('the shared quiet log include', () => {
  it('turns off every setting that could record a password, and sets its sentinel last', () => {
    for (const statement of [
      'set debug_print_parse = off;',
      'set debug_print_rewritten = off;',
      'set debug_print_plan = off;',
      "set log_statement = 'none';",
      "set log_min_error_statement = 'panic';",
      'set log_min_duration_statement = -1;',
      'set log_min_duration_sample = -1;',
      'set log_transaction_sample_rate = 0;',
      'set pg_stat_statements.track_utility = off;',
    ]) {
      expect(quiet, statement).toContain(statement);
    }
    expect(quiet).toMatch(/pgaudit\|auto_explain/);
    expect(quiet).toContain('DREFYN_BOOTSTRAP_LOG_CHECKED');
    const lines = quiet.trim().split('\n');
    expect(lines.at(-1)).toBe('\\set drefyn_log_quiet true');
  });

  it('is the only copy: the bootstrap includes it before reading any password', () => {
    const include = bootstrap.indexOf('\\ir quiet-log.sql');
    const getenv = bootstrap.indexOf('\\getenv');
    expect(include).toBeGreaterThanOrEqual(0);
    expect(include).toBeLessThan(getenv);
    expect(bootstrap).not.toContain('set log_statement');
    expect(bootstrap).not.toContain('debug_print_parse');
  });
});

describe('the role lists', () => {
  const roles = ['drefyn_owner', ...Object.values(POOL_ROLES)].sort();

  it('the bootstrap creates drefyn_auth exactly as the upgrade does', () => {
    expect(createRole(bootstrap, 'drefyn_auth')).toBe(`${ATTRIBUTES} password :'auth_password'`);
    expect(bootstrap).toMatch(/grant connect on database :"dbname" to [^;]*\bdrefyn_auth\b/);
  });

  it('the bootstrap refuses to run again when any of the roles exists', () => {
    const check = /select exists \(\s*select from pg_roles where rolname in \(([^)]*)\)/.exec(
      bootstrap,
    );
    const listed = (check?.[1] ?? '').match(/drefyn_\w+/g) ?? [];
    expect([...listed].sort()).toEqual(roles);
  });

  it('the healthcheck looks for and logs in as every role', () => {
    const health = read(postgres, 'healthcheck.sh');
    const wanted = /unnest\(array\[([^\]]*)\]\)/.exec(health)?.[1] ?? '';
    expect((wanted.match(/drefyn_\w+/g) ?? []).sort()).toEqual(roles);
    const logins = /for role in (drefyn_\w+(?: drefyn_\w+)*); do/.exec(health)?.[1] ?? '';
    expect(logins.split(' ').sort()).toEqual(roles);
  });

  it('compose passes a secret for every role, and the example env names each password', () => {
    const compose = read(repoRoot, 'deploy', 'compose.yaml');
    const example = read(repoRoot, 'deploy', '.env.example');
    for (const role of roles) {
      expect(compose, role).toContain(`      - ${role}_password\n`);
      const variable = `DREFYN_${role.replace(/^drefyn_/, '').toUpperCase()}_PASSWORD`;
      expect(compose, variable).toContain(`environment: ${variable}\n`);
      expect(example, variable).toMatch(new RegExp(`^${variable}=$`, 'm'));
    }
  });

  it('compose mounts the include and the upgrade folder beside the bootstrap', () => {
    const compose = read(repoRoot, 'deploy', 'compose.yaml');
    expect(compose).toContain('./postgres/quiet-log.sql:/etc/drefyn/quiet-log.sql:ro');
    expect(compose).toContain('./postgres/upgrade:/etc/drefyn/upgrade:ro');
  });
});

// The upgrade notes are how a self hoster finds the one command, so a fence that swallows the
// rest of the page breaks them.
describe('the self host README', () => {
  const readme = read(repoRoot, 'deploy', 'README.md');
  const lines = readme.split('\n');

  it('opens and closes every code fence with three backticks on a line of its own', () => {
    const fences = lines.filter((line) => line.includes('```'));
    for (const line of fences) expect(line).toMatch(/^```[a-z]*$/);
    expect(fences.length % 2).toBe(0);
  });

  it('shows the managed upgrade command in its own block', () => {
    const at = lines.indexOf(
      'psql --no-psqlrc --dbname drefyn --file deploy/postgres/upgrade/0001-auth-role.sql',
    );
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe('```sh');
    expect(lines[at + 1]).toBe('```');
  });

  it('keeps the postgres and template1 note with the bootstrap, before the upgrade', () => {
    const note = readme.indexOf('On `postgres` and');
    const bootstrap = readme.indexOf('--file deploy/postgres/bootstrap.sql');
    const upgradeCommand = readme.indexOf('--file deploy/postgres/upgrade/0001-auth-role.sql');
    expect(note).toBeGreaterThan(bootstrap);
    expect(note).toBeLessThan(upgradeCommand);
  });
});
