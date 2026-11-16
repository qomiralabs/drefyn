export type StatusErrorCode = 'STATUS_INPUT_INVALID' | 'STATUS_RULE_INVALID';

// Fixed text per code: rejected values come from stored rows and callers, and stay out of logs.
const MESSAGES: Readonly<Record<StatusErrorCode, string>> = {
  STATUS_INPUT_INVALID: 'counts and intervals must be safe integers in range',
  STATUS_RULE_INVALID: 'rule config does not match the rule schema',
};

export class StatusError extends Error {
  override readonly name = 'StatusError';
  readonly code: StatusErrorCode;

  constructor(code: StatusErrorCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}
