import type { Result } from '@drefyn/mdx';
import type { EngineErrorCode } from './vocabulary.ts';

// Field names and codes only, as an error reaches logs and clients.
export interface EngineIssue {
  readonly path: string;
  readonly code: string;
  readonly line?: number;
  readonly column?: number;
  // A checked id. Lets a client name the field without a value ever appearing here.
  readonly fieldId?: string;
  // Fixed text, for a person to act on.
  readonly message?: string;
}

export interface EngineError {
  readonly code: EngineErrorCode;
  readonly retryable: boolean;
  readonly issues: readonly EngineIssue[];
}

export type EngineResult<T> = Result<T, EngineError>;

export const engineError = (
  code: EngineErrorCode,
  issues: readonly EngineIssue[] = [],
): EngineError => ({ code, retryable: code === 'engine.unavailable', issues });

export const refuse = <T>(
  code: EngineErrorCode,
  issues?: readonly EngineIssue[],
): EngineResult<T> => ({ ok: false, error: engineError(code, issues) });

// Thrown inside a transaction so a refused write rolls back whatever came before it.
export class Refusal extends Error {
  readonly error: EngineError;

  constructor(code: EngineErrorCode, issues?: readonly EngineIssue[]) {
    super(code);
    this.name = 'Refusal';
    this.error = engineError(code, issues);
  }
}
