export type FlagErrorCode = 'FLAG_DEFINITION_INVALID' | 'FLAG_CONFIG_INVALID';

// Why a definition was refused, so a test can tell one broken rule from another.
export type DefinitionProblem =
  | 'name_pattern'
  | 'unknown_area'
  | 'unknown_kind'
  | 'owner_missing'
  | 'date_invalid'
  | 'remove_by_missing'
  | 'remove_by_not_after_created'
  | 'duplicate_name'
  | 'metric_missing'
  | 'safe_value_invalid'
  | 'feature_unknown';

export type FlagConfigKey =
  | 'DREFYN_FLAGS_SOURCE'
  | 'DREFYN_FLAGS_FILE'
  | 'DREFYN_FLAGD_HOST'
  | 'DREFYN_FLAGD_SYNC_PORT'
  | 'DREFYN_FLAGS_EVAL_TIMEOUT_MS'
  | 'DREFYN_FLAGS_INIT_TIMEOUT_MS'
  | 'DREFYN_RELEASE_FLAGS';

export class FlagError extends Error {
  override readonly name = 'FlagError';
  readonly code: FlagErrorCode;
  declare readonly flag?: string;
  declare readonly problem?: DefinitionProblem;
  declare readonly key?: FlagConfigKey;

  constructor(
    code: FlagErrorCode,
    detail: { flag?: string; problem?: DefinitionProblem; key?: FlagConfigKey } = {},
  ) {
    super(code);
    this.code = code;
    if (detail.flag !== undefined) this.flag = detail.flag;
    if (detail.problem !== undefined) this.problem = detail.problem;
    if (detail.key !== undefined) this.key = detail.key;
  }
}

// Stub marker for the test first commit; every caller is replaced by the implementation.
export function notImplemented(what: string, ...args: unknown[]): never {
  throw new Error(`${what}: not implemented (called with ${String(args.length)} arguments)`);
}
