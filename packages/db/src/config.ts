import { notImplemented } from './not-implemented.ts';

export type SslMode = 'require' | 'verify-full' | 'disable';

export type Env = Readonly<Record<string, string | undefined>>;

export interface DatabaseConfig {
  readonly url: string;
  readonly poolMax: number;
  readonly poolWaitMs: number;
  readonly statementTimeoutMs: number;
  readonly ssl: SslMode;
}

export interface MigrationConfig {
  readonly url: string;
  readonly ssl: SslMode;
}

// Reads DREFYN_DATABASE_URL and the pool, timeout and SSL keys. Throws DbError
// DB_CONFIG_INVALID naming the key; the message never carries a password or the URL.
export function parseDatabaseConfig(env: Env): DatabaseConfig {
  return notImplemented('parseDatabaseConfig', env);
}

// Reads DREFYN_MIGRATION_DATABASE_URL and DREFYN_DATABASE_SSL only.
export function parseMigrationConfig(env: Env): MigrationConfig {
  return notImplemented('parseMigrationConfig', env);
}
