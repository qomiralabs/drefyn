import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultMigrationsDir } from '../../../src/constants.ts';
import { start, type Finished, type Running } from './process.ts';
import { packageRoot } from './stack.ts';

const cliPath = join(packageRoot, 'src', 'cli.ts');

export interface MigrateOptions {
  readonly url: string;
  readonly migrationsDir?: string;
  readonly env?: Readonly<Record<string, string>>;
}

function childEnv(options: MigrateOptions): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    DREFYN_MIGRATION_DATABASE_URL: options.url,
    DREFYN_DATABASE_SSL: 'disable',
    ...options.env,
  };
}

function argv(args: readonly string[], options: MigrateOptions): string[] {
  return [
    cliPath,
    ...args,
    ...(options.migrationsDir === undefined ? [] : ['--migrations-dir', options.migrationsDir]),
  ];
}

// The real command in its own process, so the exit code is the one an operator sees.
export function startMigrate(args: readonly string[], options: MigrateOptions): Running {
  return start(process.execPath, argv(args, options), { env: childEnv(options) });
}

export function migrate(args: readonly string[], options: MigrateOptions): Promise<Finished> {
  return startMigrate(args, options).done;
}

export function shippedMigrations(): string[] {
  return readdirSync(defaultMigrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

// The name node-pg-migrate records: the file name without .sql.
export const recordedName = (file: string) => file.replace(/\.sql$/, '');

export function migration(up: string, down: string): string {
  return `-- Up Migration\n${up}\n\n-- Down Migration\n${down}\n`;
}

const dirs: string[] = [];

// Called from the afterAll that databases() registers at the top of each file; a hook
// registered from inside a test body would never run.
export function removeFixtureDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

// A copy of the shipped migrations plus fixture files, which sort after them.
export function fixtureMigrations(
  extra: Readonly<Record<string, string>>,
  options: { shipped?: boolean } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'drefyn-db-it-'));
  dirs.push(dir);
  if (options.shipped !== false && existsSync(defaultMigrationsDir)) {
    cpSync(defaultMigrationsDir, dir, { recursive: true });
  }
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return dir;
}

export function describeFailure(result: Finished): string {
  return `exit ${String(result.code)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

export type { Finished };
