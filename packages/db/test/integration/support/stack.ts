import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { run } from './process.ts';

export const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
export const packageRoot = resolve(import.meta.dirname, '..', '..', '..');
export const composeFile = join(repoRoot, 'deploy', 'compose.yaml');

export interface Stack {
  readonly project: string;
  readonly port: string;
  readonly passwords: Readonly<Record<'owner' | 'app' | 'reader', string>>;
}

function envFile(): Record<string, string> {
  const values: Record<string, string> = {};
  const text = readFileSync(join(repoRoot, 'deploy', '.env'), 'utf8');
  for (const line of text.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
}

let cached: Stack | undefined;

// The project name is required, never defaulted: these tests create and drop databases, and
// the default name may belong to another stack on the same machine.
export function stack(): Stack {
  if (cached !== undefined) return cached;
  const project = process.env['COMPOSE_PROJECT_NAME'] ?? '';
  if (project === '') {
    throw new Error(
      'Set COMPOSE_PROJECT_NAME to the compose project started with scripts/selfhost.sh up; the integration tests never assume one.',
    );
  }
  const file = envFile();
  const need = (key: string) => {
    const value = file[key];
    if (value === undefined || value === '') throw new Error(`deploy/.env has no ${key}`);
    return value;
  };
  cached = {
    project,
    port: process.env['DREFYN_POSTGRES_PORT'] ?? file['DREFYN_POSTGRES_PORT'] ?? '55432',
    passwords: {
      owner: need('DREFYN_OWNER_PASSWORD'),
      app: need('DREFYN_APP_PASSWORD'),
      reader: need('DREFYN_PUBLIC_READER_PASSWORD'),
    },
  };
  return cached;
}

export type Role = 'owner' | 'app' | 'reader' | 'auth';
const ROLE_NAMES: Record<Role, string> = {
  owner: 'drefyn_owner',
  app: 'drefyn_app',
  reader: 'drefyn_public_reader',
  auth: 'drefyn_auth',
};

// Read on demand, so files that never open the auth pool still run against a deploy/.env
// from before the role.
export function authPassword(): string {
  const value = envFile()['DREFYN_AUTH_PASSWORD'] ?? '';
  if (value === '') throw new Error('deploy/.env has no DREFYN_AUTH_PASSWORD');
  return value;
}

export function roleName(role: Role): string {
  return ROLE_NAMES[role];
}

export function urlFor(role: Role, database: string, password?: string): string {
  const s = stack();
  const secret = encodeURIComponent(
    password ?? (role === 'auth' ? authPassword() : s.passwords[role]),
  );
  return `postgres://${ROLE_NAMES[role]}:${secret}@127.0.0.1:${s.port}/${database}`;
}

function compose(args: readonly string[], input?: string) {
  const s = stack();
  return run('docker', ['compose', '-p', s.project, '-f', composeFile, ...args], {
    env: { ...process.env, COMPOSE_PROJECT_NAME: s.project },
    ...(input === undefined ? {} : { input }),
  });
}

// The superuser only logs in over the container's socket, so its work goes through exec.
// Admin work connects to postgres, never to drefyn, which is the template source.
export async function superuser(sql: string, database = 'postgres'): Promise<string> {
  const result = await compose(
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-qAt',
      '-U',
      'postgres',
      '-d',
      database,
    ],
    sql,
  );
  if (result.code !== 0) throw new Error(`superuser psql on ${database} failed: ${result.stderr}`);
  return result.stdout;
}

// pg_dump 18 prints a random \restrict key on every run, which is not schema.
export async function schemaDump(
  database: string,
  exclude: readonly string[] = [],
): Promise<string> {
  const args = [
    'exec',
    '-T',
    'postgres',
    'pg_dump',
    '--schema-only',
    '-U',
    'postgres',
    '-d',
    database,
  ];
  for (const pattern of exclude) args.push(`--exclude-table=${pattern}`);
  const result = await compose(args);
  if (result.code !== 0) throw new Error(`pg_dump ${database} failed: ${result.stderr}`);
  return result.stdout
    .split('\n')
    .filter((line) => !/^\\(un)?restrict /.test(line))
    .join('\n');
}
