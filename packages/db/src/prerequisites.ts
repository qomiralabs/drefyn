import { VECTOR_VERSION_FLOOR, meetsVersionFloor } from './version.ts';

// The vector row from pg_extension, or undefined when it is not installed.
export interface VectorExtension {
  readonly schema: string;
  readonly version: string;
}

export type PrerequisiteProblem =
  | 'vector_missing'
  | 'vector_wrong_schema'
  | 'vector_too_old'
  | 'role_missing'
  | 'role_cannot_connect';

// What the session read for one role in UPGRADE_ROLES.
export interface RoleAccess {
  readonly role: string;
  readonly exists: boolean;
  // CONNECT on the database migrate is connected to.
  readonly canConnect: boolean;
}

// Roles that came after the first bootstrap shipped. A database set up before then has none
// of them, bootstrap.sql never runs twice, and drefyn_owner cannot create roles, so each has
// an upgrade script run by whoever can.
export const UPGRADE_ROLES: readonly { readonly role: string; readonly script: string }[] = [
  { role: 'drefyn_auth', script: 'deploy/postgres/upgrade/0001-auth-role.sql' },
];

export type PrerequisiteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: PrerequisiteProblem; readonly message: string };

const EXTENSION_SCHEMA = 'extensions';

// The superuser only logs in over the container's socket, so the compose form goes through exec.
const composePsql = (statement: string) =>
  `docker compose -f deploy/compose.yaml exec -T postgres psql --no-psqlrc -U postgres -d drefyn -c '${statement}'`;

// Migrations never create or change an extension: drefyn_owner owns neither the extension nor
// its schema. Each message is the operator step, run by whoever does own them.
function missing(): string {
  const statement = `create extension vector schema ${EXTENSION_SCHEMA}`;
  return [
    'The vector extension is not installed in this database.',
    `Install it with: ${statement}`,
    'Run it as the superuser on compose or as the master user on managed Postgres, never as drefyn_owner.',
    `On compose: ${composePsql(statement)}`,
    'deploy/postgres/bootstrap.sql will not run again on a database it already set up, so this one statement is the fix.',
    `A database with no schema ${EXTENSION_SCHEMA} was never bootstrapped; run the bootstrap on a fresh database instead.`,
  ].join('\n');
}

function wrongSchema(schema: string): string {
  const statement = `alter extension vector set schema ${EXTENSION_SCHEMA}`;
  return [
    `The vector extension is installed in schema ${JSON.stringify(schema)}, not in ${EXTENSION_SCHEMA}.`,
    `Move it with: ${statement}`,
    'Run it as the superuser on compose or as the master user on managed Postgres, never as drefyn_owner.',
    `On compose: ${composePsql(statement)}`,
  ].join('\n');
}

function tooOld(version: string): string {
  return [
    `The vector extension is at ${JSON.stringify(version)}; drefyn needs ${VECTOR_VERSION_FLOOR} or later.`,
    `On compose: ${composePsql('alter extension vector update')}`,
    "On managed Postgres, as the master user: alter extension vector update to '<version>'",
  ].join('\n');
}

export function evaluatePrerequisites(vector: VectorExtension | undefined): PrerequisiteResult {
  if (vector === undefined) return { ok: false, problem: 'vector_missing', message: missing() };
  // Schema first: updating an extension in the wrong place would only make it harder to move.
  if (vector.schema !== EXTENSION_SCHEMA) {
    return { ok: false, problem: 'vector_wrong_schema', message: wrongSchema(vector.schema) };
  }
  if (!meetsVersionFloor(vector.version)) {
    return { ok: false, problem: 'vector_too_old', message: tooOld(vector.version) };
  }
  return { ok: true };
}

function upgradeSteps(script: string): string[] {
  return [
    `Run ${script} as the superuser on compose or as the master user on managed Postgres, never as drefyn_owner. It is safe to run again.`,
    'On compose: bash scripts/selfhost.sh upgrade',
    `On managed Postgres, as the master user with DREFYN_AUTH_PASSWORD set: psql --no-psqlrc --dbname drefyn --file ${script}`,
  ];
}

// Checked before any migration runs, so a migration that grants to one of these roles never
// fails halfway on a database that predates it. A role the session did not report at all
// counts as missing.
export function evaluateRoles(roles: readonly RoleAccess[]): PrerequisiteResult {
  for (const { role, script } of UPGRADE_ROLES) {
    const access = roles.find((r) => r.role === role);
    if (access?.exists !== true) {
      return {
        ok: false,
        problem: 'role_missing',
        message: [
          `Role ${role} does not exist; this database was set up before it was added.`,
          ...upgradeSteps(script),
        ].join('\n'),
      };
    }
    if (!access.canConnect) {
      return {
        ok: false,
        problem: 'role_cannot_connect',
        message: [
          `Role ${role} exists but has no CONNECT on this database. The upgrade grants it.`,
          ...upgradeSteps(script),
        ].join('\n'),
      };
    }
  }
  return { ok: true };
}
