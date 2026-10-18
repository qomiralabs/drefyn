import { notImplemented } from './not-implemented.ts';

export type MigrateOutcome =
  'done' | 'failed' | 'lock_held' | 'checksum_mismatch' | 'prerequisite_missing';

export const MIGRATE_OUTCOMES: readonly MigrateOutcome[] = [
  'done',
  'failed',
  'lock_held',
  'checksum_mismatch',
  'prerequisite_missing',
];

export class MigrateError extends Error {
  readonly outcome: Exclude<MigrateOutcome, 'done'>;

  constructor(outcome: Exclude<MigrateOutcome, 'done'>, message: string) {
    super(message);
    this.name = 'MigrateError';
    this.outcome = outcome;
  }
}

// The one place an outcome becomes a process exit code.
export function exitCodeFor(outcome: MigrateOutcome): number {
  return notImplemented('exitCodeFor', outcome);
}

// Classifies anything a run can throw, including the migration tool's own lock error.
export function outcomeOf(error: unknown): Exclude<MigrateOutcome, 'done'> {
  return notImplemented('outcomeOf', error);
}
