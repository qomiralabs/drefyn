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

// Part of the CLI contract: scripts and operators branch on these numbers.
const EXIT_CODES: Readonly<Record<MigrateOutcome, number>> = {
  done: 0,
  failed: 1,
  lock_held: 2,
  checksum_mismatch: 3,
  prerequisite_missing: 4,
};

// The one place an outcome becomes a process exit code.
export function exitCodeFor(outcome: MigrateOutcome): number {
  return EXIT_CODES[outcome];
}

// node-pg-migrate throws a plain Error with this text when its own lock is taken.
const TOOL_LOCK_HELD = /^Another migration is already running\b/;

// Classifies anything a run can throw, including the migration tool's own lock error.
export function outcomeOf(error: unknown): Exclude<MigrateOutcome, 'done'> {
  if (error instanceof MigrateError) return error.outcome;
  // The tool wraps errors in others with a cause; a short walk finds its lock error.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (TOOL_LOCK_HELD.test(current.message)) return 'lock_held';
    current = current.cause;
  }
  return 'failed';
}
