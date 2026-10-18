import { notImplemented } from './not-implemented.ts';

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

// Throws MigrateError('failed') naming the file when a section is missing, repeated,
// empty or out of order, or when non transactional SQL is not marked.
export function parseMigrationFile(name: string, contents: Uint8Array): MigrationFile {
  return notImplemented('parseMigrationFile', name, contents);
}

// Every .sql file in the directory, parsed and in name order, before anything connects.
export function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  return notImplemented('loadMigrationFiles', dir);
}
