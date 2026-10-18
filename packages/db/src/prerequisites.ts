import { notImplemented } from './not-implemented.ts';

// The vector row from pg_extension, or undefined when it is not installed.
export interface VectorExtension {
  readonly schema: string;
  readonly version: string;
}

export type PrerequisiteProblem = 'vector_missing' | 'vector_wrong_schema' | 'vector_too_old';

export type PrerequisiteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly problem: PrerequisiteProblem; readonly message: string };

export function evaluatePrerequisites(vector: VectorExtension | undefined): PrerequisiteResult {
  return notImplemented('evaluatePrerequisites', vector);
}
