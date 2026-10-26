import type { TestProject } from 'vitest/node';
import { migrate } from './cli.ts';
import {
  BOOTSTRAPPED,
  TEST_PREFIX,
  cloneDatabase,
  closeTemplate,
  dropDatabase,
  newName,
  sweepDatabases,
  type Templates,
} from './databases.ts';
import { stackAbsence, stackRule } from './presence.ts';
import { takeRunLock } from './run-lock.ts';
import { prepareRun } from './run-setup.ts';
import { stack, urlFor } from './stack.ts';

// Two templates per run: one straight from the bootstrap, one with the shipped migrations
// applied by the real command. Test files clone whichever they need.
async function buildTemplates(): Promise<Templates> {
  const base = newName('base');
  const migrated = newName('migrated');
  await cloneDatabase(BOOTSTRAPPED, base);
  await closeTemplate(base);
  await cloneDatabase(base, migrated);
  const result = await migrate(['migrate', 'up'], { url: urlFor('owner', migrated) });
  await closeTemplate(migrated);
  return {
    base,
    migrated,
    migratedError:
      result.code === 0
        ? null
        : `drefyn migrate up on the migrated template exited ${String(result.code)}:\n${result.stderr}`,
  };
}

export default async function setup(project: TestProject) {
  const absent = await stackAbsence();
  const rule = stackRule(absent, process.env);
  if (rule === 'fail') {
    throw new Error(`integration tests need the compose stack in CI: ${absent ?? ''}`);
  }
  project.provide('stackAbsent', absent);
  if (rule === 'skip') {
    project.provide('templates', { base: '', migrated: '', migratedError: absent });
    return;
  }
  stack();
  const run = await prepareRun({
    takeLock: takeRunLock,
    sweep: () => sweepDatabases(TEST_PREFIX),
    buildTemplates,
    dropTemplates: async ({ base, migrated }) => {
      await dropDatabase(migrated);
      await dropDatabase(base);
    },
  });
  if (run.swept.length > 0) {
    console.info(
      `dropped ${String(run.swept.length)} leftover test databases: ${run.swept.join(', ')}`,
    );
  }
  project.provide('templates', run.templates);
  return () => run.teardown();
}
