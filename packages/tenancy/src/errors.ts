export type TenancyErrorCode =
  | 'ID_MALFORMED'
  | 'ID_WRONG_TYPE'
  | 'ID_KIND_UNKNOWN'
  | 'TENANT_REF_INVALID'
  | 'CACHE_SCOPE_UNKNOWN'
  | 'CACHE_PART_INVALID';

// Fixed text per code: the rejected value is untrusted, can be huge and would end up in logs.
const MESSAGES: Readonly<Record<TenancyErrorCode, string>> = {
  ID_MALFORMED: 'id is not in its canonical form',
  ID_WRONG_TYPE: 'id belongs to another kind',
  ID_KIND_UNKNOWN: 'id kind is not one of ID_KINDS',
  TENANT_REF_INVALID: 'tenant ref is not an object',
  CACHE_SCOPE_UNKNOWN: 'cache scope is not a known scope',
  CACHE_PART_INVALID: 'cache key parts must be strings',
};

export class TenancyError extends Error {
  readonly code: TenancyErrorCode;

  constructor(code: TenancyErrorCode) {
    super(MESSAGES[code]);
    this.name = 'TenancyError';
    this.code = code;
  }
}
