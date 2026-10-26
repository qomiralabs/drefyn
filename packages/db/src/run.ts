import { resolve } from 'node:path';
import { parseMigrateArgs, type MigrateCommand } from './args.ts';
import { verifyChecksums, type ChecksumProblem, type RecordedMigration } from './checksum.ts';
import { parseMigrationConfig, type Env, type MigrationConfig } from './config.ts';
import { MIGRATION_ROLE, defaultMigrationsDir } from './constants.ts';
import { DbError } from './errors.ts';
import { loadMigrationFiles, type MigrationFile } from './migration-file.ts';
import { MigrateError, exitCodeFor, outcomeOf } from './outcome.ts';
import { connectPg } from './pg-session.ts';
import { evaluatePrerequisites, type VectorExtension } from './prerequisites.ts';

export interface Output {
  write(text: string): void;
}

export interface ConnectedRole {
  readonly name: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
}

export interface RunRequest {
  readonly direction: 'up' | 'down';
  readonly count: number;
  readonly dir: string;
  readonly files: readonly MigrationFile[];
  readonly stdout: Output;
  readonly stderr: Output;
}

// Everything a run asks of the database, in the words of the command. The pg adapter is in
// pg-session.ts; tests drive the order through a fake.
export interface MigrateSession {
  role(): Promise<ConnectedRole>;
  vectorExtension(): Promise<VectorExtension | undefined>;
  // pg_try_advisory_lock on the shared key; false when another session holds it.
  tryLock(): Promise<boolean>;
  // Rolls back anything left open, then releases the lock.
  unlock(): Promise<void>;
  setLockTimeout(): Promise<void>;
  // Why an existing app.pgmigrations cannot be used, or undefined when it can or is absent.
  trackingTableProblem(): Promise<string | undefined>;
  // Applied migrations in run order, as the tool names them (no .sql), with their hashes.
  // Reads only; an absent table means nothing applied.
  history(): Promise<RecordedMigration[]>;
  ensureBookkeeping(): Promise<void>;
  run(request: RunRequest): Promise<void>;
  close(): Promise<void>;
}

export type Connect = (config: MigrationConfig) => Promise<MigrateSession>;

export interface RunMigrateOptions {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly stdout: Output;
  readonly stderr: Output;
  // Defaults to the pg adapter.
  readonly connect?: Connect;
}

const fileName = (recorded: string) => `${recorded}.sql`;

function describeProblem(problem: ChecksumProblem, dir: string): string {
  switch (problem.kind) {
    case 'changed':
      return `${problem.name} changed after it ran (recorded ${problem.recorded}, now ${problem.actual})`;
    case 'missing':
      return `${problem.name} ran but is not in ${dir}`;
    case 'unrecorded':
      return `${problem.name} ran with no recorded checksum`;
  }
}

function checksumProblems(
  history: readonly RecordedMigration[],
  files: readonly MigrationFile[],
): ChecksumProblem[] {
  return verifyChecksums(
    history.map((h) => ({ name: fileName(h.name), sha256: h.sha256 })),
    files.map((f) => ({ name: f.name, sha256: f.sha256 })),
  );
}

function mismatch(problems: readonly ChecksumProblem[], dir: string): MigrateError {
  return new MigrateError(
    'checksum_mismatch',
    [
      'applied migrations no longer match the files that ran, so nothing was run:',
      ...problems.map((p) => `  ${describeProblem(p, dir)}`),
      'There is no override. See "Exit code 3" in the @drefyn/db README for the repair steps.',
    ].join('\n'),
  );
}

async function checkRoleAndPrerequisites(session: MigrateSession): Promise<void> {
  const role = await session.role();
  if (role.name !== MIGRATION_ROLE || role.superuser || role.bypassRls) {
    const flags = [role.superuser ? 'superuser' : '', role.bypassRls ? 'BYPASSRLS' : '']
      .filter((f) => f !== '')
      .join(', ');
    throw new MigrateError(
      'failed',
      `drefyn migrate runs only as ${MIGRATION_ROLE}, without superuser or BYPASSRLS; connected as ${role.name}${flags === '' ? '' : ` (${flags})`}`,
    );
  }
  // Before the lock, so a missing extension never holds up a concurrent run.
  const prerequisites = evaluatePrerequisites(await session.vectorExtension());
  if (!prerequisites.ok) throw new MigrateError('prerequisite_missing', prerequisites.message);
}

// A snapshot that never creates anything and never takes the lock, so it is safe against
// production at any time. It may race a running up.
async function status(
  session: MigrateSession,
  files: readonly MigrationFile[],
  dir: string,
  stdout: Output,
): Promise<void> {
  const problem = await session.trackingTableProblem();
  if (problem !== undefined) throw new MigrateError('failed', problem);
  const history = await session.history();
  const problems = checksumProblems(history, files);
  const byName = new Map(problems.map((p) => [p.name, p.kind]));
  const applied = new Set(history.map((h) => fileName(h.name)));
  for (const h of history) {
    const name = fileName(h.name);
    stdout.write(`${byName.get(name) ?? 'applied'}  ${name}\n`);
  }
  for (const file of files) {
    if (!applied.has(file.name)) stdout.write(`pending  ${file.name}\n`);
  }
  if (problems.length > 0) throw mismatch(problems, dir);
}

async function change(
  session: MigrateSession,
  command: Extract<MigrateCommand, { command: 'up' | 'down' }>,
  files: readonly MigrationFile[],
  dir: string,
  stdout: Output,
  stderr: Output,
): Promise<void> {
  if (!(await session.tryLock())) {
    throw new MigrateError('lock_held', 'another run holds the migration lock; nothing was run');
  }
  try {
    await session.setLockTimeout();
    // Checked before anything is created, so a refusal leaves the database as it was.
    const problem = await session.trackingTableProblem();
    if (problem !== undefined) throw new MigrateError('failed', problem);
    const problems = checksumProblems(await session.history(), files);
    if (problems.length > 0) throw mismatch(problems, dir);
    await session.ensureBookkeeping();
    await session.run({
      direction: command.command,
      count: command.command === 'down' ? command.count : Number.POSITIVE_INFINITY,
      dir,
      files,
      stdout,
      stderr,
    });
  } finally {
    // Closing the connection releases a session lock too, so a failed unlock only warns
    // and never hides the error that got here.
    await session.unlock().catch((error: unknown) => {
      stderr.write(
        `drefyn migrate: warning: could not release the lock: ${describeError(error)}\n`,
      );
    });
  }
}

function describeError(error: unknown): string {
  if (error instanceof DbError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) {
    // Connection errors from Node can carry an empty message and only a code.
    const code = (error as { code?: unknown }).code;
    if (error.message !== '') return error.message;
    return typeof code === 'string' ? code : error.name;
  }
  return 'unknown error';
}

// Resolves to the process exit code; never throws. Order: arguments, config, every file
// parsed (no connection yet), connect, role, prerequisites, then the command.
export async function runMigrate(options: RunMigrateOptions): Promise<number> {
  const { stdout, stderr } = options;
  try {
    const command = parseMigrateArgs(options.argv);
    const config = parseMigrationConfig(options.env);
    const dir = resolve(command.migrationsDir ?? defaultMigrationsDir);
    const files = await loadMigrationFiles(dir, {
      warn: (line) => {
        stderr.write(`${line}\n`);
      },
    });
    const session = await (options.connect ?? connectPg)(config);
    try {
      await checkRoleAndPrerequisites(session);
      if (command.command === 'status') await status(session, files, dir, stdout);
      else await change(session, command, files, dir, stdout, stderr);
    } finally {
      await session.close().catch((error: unknown) => {
        stderr.write(
          `drefyn migrate: warning: could not close the connection: ${describeError(error)}\n`,
        );
      });
    }
    return exitCodeFor('done');
  } catch (error) {
    stderr.write(`drefyn migrate: ${describeError(error)}\n`);
    return exitCodeFor(outcomeOf(error));
  }
}
