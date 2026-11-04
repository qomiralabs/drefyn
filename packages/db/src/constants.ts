import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The migration tool's own well known key. Sharing it means a plain node-pg-migrate run
// that skips the checksums is still kept out while drefyn migrate holds the lock.
export const MIGRATE_LOCK_KEY = 7241865325823964n;

// drefyn_owner may create objects only in app, so the bookkeeping lives there too.
export const MIGRATIONS_SCHEMA = 'app';
export const MIGRATIONS_TABLE = 'pgmigrations';
export const CHECKSUMS_TABLE = 'migration_checksums';

export const MIGRATION_ROLE = 'drefyn_owner';

// Joined by hand: a bundler reads new URL(path, import.meta.url) as an asset to copy, and
// the dashboard, which never migrates, bundles this file.
export const defaultMigrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations/',
);
