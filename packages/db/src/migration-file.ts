import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from './checksum.ts';
import { MigrateError } from './outcome.ts';

export interface MigrationFile {
  readonly name: string;
  readonly up: string;
  readonly down: string;
  readonly sha256: string;
  // False only for a file marked to run outside a transaction.
  readonly transaction: boolean;
}

// Marks a file that must run outside a transaction, for example create index concurrently.
export const NO_TRANSACTION_MARKER = '-- drefyn: no-transaction';

// The migration tool interpolates the recorded name into SQL, so this rule is what keeps
// that safe. Digits, one underscore, then lower case words joined by single underscores.
export const MIGRATION_NAME = /^[0-9]{13}_[a-z0-9]+(_[a-z0-9]+)*\.sql$/;

const UP_MARKER = '-- Up Migration';
const DOWN_MARKER = '-- Down Migration';

// The tool's own marker pattern. A line it would split on that is not exactly one of ours
// would move SQL into the other direction if the file ever reached the tool's parser.
const NEAR_MARKER = /^\s*--[\s-]*(up|down)\s+migration/i;

// Statements Postgres refuses inside a transaction block.
const NON_TRANSACTIONAL =
  /\b(create\s+(unique\s+)?index|drop\s+index|reindex)\b[^;]*?\bconcurrently\b/i;

const utf8 = new TextDecoder('utf-8', { fatal: true });

function refuse(name: string, why: string): never {
  throw new MigrateError('failed', `migration ${name}: ${why}`);
}

const isComment = (line: string) => line.trimStart().startsWith('--');

// Section text with line comments and blank lines removed, for the checks only.
function statementsOf(section: string): string {
  return section
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n')
    .trim();
}

// Throws MigrateError('failed') naming the file when a section is missing, repeated,
// empty or out of order, or when non transactional SQL is not marked.
export function parseMigrationFile(name: string, contents: Uint8Array): MigrationFile {
  if (!MIGRATION_NAME.test(name)) {
    refuse(
      name,
      'not a migration file name; expected 13 digits, an underscore, lower case words and .sql',
    );
  }
  let text: string;
  try {
    text = utf8.decode(contents);
  } catch {
    return refuse(name, 'is not valid UTF-8');
  }
  // CRLF files are read as written; the hash above the split still covers every byte.
  const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));

  let up = -1;
  let down = -1;
  for (const [index, line] of lines.entries()) {
    if (line === UP_MARKER) {
      if (up !== -1) refuse(name, `repeats ${UP_MARKER}`);
      up = index;
    } else if (line === DOWN_MARKER) {
      if (down !== -1) refuse(name, `repeats ${DOWN_MARKER}`);
      down = index;
    } else if (NEAR_MARKER.test(line)) {
      refuse(
        name,
        `line ${String(index + 1)} looks like a section marker but is not exactly ${UP_MARKER} or ${DOWN_MARKER}`,
      );
    }
  }
  if (up === -1) refuse(name, `has no ${UP_MARKER} section`);
  if (down === -1) refuse(name, `has no ${DOWN_MARKER} section`);
  if (down < up) refuse(name, `has ${DOWN_MARKER} before ${UP_MARKER}`);

  // Above the up section only comments, blank lines and the marker may appear; any SQL
  // there would never run.
  let transaction = true;
  for (const line of lines.slice(0, up)) {
    if (line === NO_TRANSACTION_MARKER) transaction = false;
    else if (line.trim() !== '' && !isComment(line)) refuse(name, `has SQL above ${UP_MARKER}`);
  }

  const upSql = lines
    .slice(up + 1, down)
    .join('\n')
    .trim();
  const downSql = lines
    .slice(down + 1)
    .join('\n')
    .trim();
  for (const [label, section] of [
    ['up', upSql],
    ['down', downSql],
  ] as const) {
    const statements = statementsOf(section);
    if (statements === '') refuse(name, `has an empty ${label} section`);
    if (transaction && NON_TRANSACTIONAL.test(statements)) {
      refuse(
        name,
        `its ${label} section cannot run in a transaction; put ${NO_TRANSACTION_MARKER} on its own line above ${UP_MARKER}`,
      );
    }
  }

  return { name, up: upSql, down: downSql, sha256: sha256Hex(contents), transaction };
}

export interface LoadOptions {
  // Told about each skipped name that starts with a dot, such as .DS_Store.
  readonly warn?: (message: string) => void;
}

// Every .sql file in the directory, parsed and in name order, before anything connects.
// Anything else in the folder refuses the whole folder: the migration tool would hand an
// unknown file to a loader that runs it as code.
export async function loadMigrationFiles(
  dir: string,
  options: LoadOptions = {},
): Promise<MigrationFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new MigrateError(
      'failed',
      `cannot read the migrations folder ${dir}${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  }

  const names: string[] = [];
  const problems: string[] = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name.startsWith('.')) {
      options.warn?.(
        `drefyn migrate: skipped ${entry.name} in ${dir}; names starting with a dot are never read`,
      );
      continue;
    }
    // Dirent comes from lstat, so a symlink is not a file here.
    if (!entry.isFile()) problems.push(`${entry.name} is not a regular file`);
    else if (!MIGRATION_NAME.test(entry.name))
      problems.push(`${entry.name} is not a migration file name`);
    else names.push(entry.name);
  }

  // Equal prefixes sort by name and can order differently on two branches.
  const byPrefix = new Map<string, string[]>();
  for (const name of names) {
    const prefix = name.slice(0, 13);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), name]);
  }
  for (const [prefix, files] of byPrefix) {
    if (files.length > 1) problems.push(`${files.join(' and ')} share the prefix ${prefix}`);
  }

  if (problems.length > 0) {
    throw new MigrateError(
      'failed',
      `the migrations folder ${dir} holds files that are not migrations; nothing was run:\n${problems.map((p) => `  ${p}`).join('\n')}\nOnly files named like 1760000000000_create_widgets.sql belong there.`,
    );
  }

  const files: MigrationFile[] = [];
  for (const name of names) {
    let contents: Uint8Array;
    try {
      contents = await readFile(join(dir, name));
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new MigrateError(
        'failed',
        `cannot read migration ${name}${typeof code === 'string' ? ` (${code})` : ''}`,
      );
    }
    files.push(parseMigrationFile(name, contents));
  }
  return files;
}
