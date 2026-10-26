import type { Templates } from './databases.ts';

export interface RunSteps {
  // Fails at once when another run holds it.
  takeLock(): Promise<{ release(): Promise<void> }>;
  // Drops leftovers from runs that died; returns what it dropped.
  sweep(): Promise<string[]>;
  buildTemplates(): Promise<Templates>;
  dropTemplates(templates: Templates): Promise<void>;
}

export interface PreparedRun {
  readonly templates: Templates;
  readonly swept: readonly string[];
  teardown(): Promise<void>;
}

// Lock, then sweep, then build: a sweep without the lock could drop another run's live
// clones, and templates built before the sweep could be swept themselves. The lock is held
// until teardown and released on any failure on the way.
export async function prepareRun(steps: RunSteps): Promise<PreparedRun> {
  const lock = await steps.takeLock();
  try {
    const swept = await steps.sweep();
    const templates = await steps.buildTemplates();
    return {
      templates,
      swept,
      async teardown() {
        try {
          await steps.dropTemplates(templates);
        } finally {
          await lock.release();
        }
      },
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}
