export type DbErrorCode =
  | 'DB_CONFIG_INVALID'
  | 'DB_ROLE_UNSAFE'
  | 'DB_TENANT_CONTEXT_MISSING'
  | 'DB_RLS_VIOLATION'
  | 'DB_UNIQUE_VIOLATION'
  | 'DB_IDEMPOTENCY_CONFLICT'
  | 'DB_TIMEOUT'
  | 'DB_UNAVAILABLE'
  | 'INTEGER_INVALID';

export class DbError extends Error {
  readonly code: DbErrorCode;

  constructor(code: DbErrorCode, message: string) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}
