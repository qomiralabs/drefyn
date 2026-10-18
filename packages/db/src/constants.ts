import { fileURLToPath } from 'node:url';

// The migration tool's own well known key. Sharing it means a plain node-pg-migrate run
// that skips the checksums is still kept out while drefyn migrate holds the lock.
export const MIGRATE_LOCK_KEY = 7241865325823964n;

// drefyn_owner may create objects only in app, so the bookkeeping lives there too.
export const MIGRATIONS_SCHEMA = 'app';
export const MIGRATIONS_TABLE = 'pgmigrations';
export const CHECKSUMS_TABLE = 'migration_checksums';

export const MIGRATION_ROLE = 'drefyn_owner';

export const defaultMigrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));
