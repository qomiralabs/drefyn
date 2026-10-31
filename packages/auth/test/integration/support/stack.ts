import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

// The auth package keeps its own small harness: the db harness is internal to that package,
// and both run at once under turbo, so this one uses its own database prefix and lock.

export const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const composeFile = join(repoRoot, 'deploy', 'compose.yaml');

// The migrate command as shipped, found through the package rather than a relative path.
export const migrateCli = join(
  dirname(createRequire(import.meta.url).resolve('@drefyn/db/package.json')),
  'src',
  'cli.ts',
);

export interface Finished {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<Finished> {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(options.input ?? '');
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('close', (code) => {
      done({ code, stdout, stderr });
    });
  });
}

// Never defaulted: these tests create and drop databases, and the default project may be
// another stack on the same machine.
export function project(): string {
  const name = process.env['COMPOSE_PROJECT_NAME'] ?? '';
  if (name === '')
    throw new Error('Set COMPOSE_PROJECT_NAME to the stack from scripts/selfhost.sh up');
  return name;
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

export type Role = 'owner' | 'app' | 'auth';
const ROLES: Readonly<Record<Role, [string, string]>> = {
  owner: ['drefyn_owner', 'DREFYN_OWNER_PASSWORD'],
  app: ['drefyn_app', 'DREFYN_APP_PASSWORD'],
  auth: ['drefyn_auth', 'DREFYN_AUTH_PASSWORD'],
};

export function urlFor(role: Role, database: string): string {
  const file = envFile();
  const [name, key] = ROLES[role];
  const password = file[key] ?? '';
  if (password === '') throw new Error(`deploy/.env has no ${key}`);
  const port = process.env['DREFYN_POSTGRES_PORT'] ?? file['DREFYN_POSTGRES_PORT'] ?? '55432';
  return `postgres://${name}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}

export function compose(args: readonly string[], input?: string): Promise<Finished> {
  const name = project();
  return run('docker', ['compose', '-p', name, '-f', composeFile, ...args], {
    env: { ...process.env, COMPOSE_PROJECT_NAME: name },
    ...(input === undefined ? {} : { input }),
  });
}

// The superuser logs in only over the container socket. It bypasses RLS, which is what the
// tests need to move a row's clock or read what the roles cannot.
export async function superuser(sqlText: string, database = 'postgres'): Promise<string> {
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
    sqlText,
  );
  if (result.code !== 0) throw new Error(`superuser psql on ${database} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// Why the stack cannot be used here, or null when it can.
export async function stackAbsence(): Promise<string | null> {
  if ((process.env['COMPOSE_PROJECT_NAME'] ?? '') === '') return 'COMPOSE_PROJECT_NAME is not set';
  const result = await compose(['ps', '--status', 'running', '--services']).catch(() => null);
  if (result?.code !== 0) return `docker compose cannot reach project ${project()}`;
  if (!result.stdout.split('\n').includes('postgres'))
    return `project ${project()} has no running postgres`;
  return null;
}

export function inCi(): boolean {
  const value = process.env['CI'] ?? '';
  return value !== '' && value !== 'false' && value !== '0';
}
