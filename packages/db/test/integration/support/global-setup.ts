import type { TestProject } from 'vitest/node';
import { migrate } from './cli.ts';
import { BOOTSTRAPPED, cloneDatabase, dropDatabase, newName } from './databases.ts';
import { stack, urlFor } from './stack.ts';

// Two templates per run: one straight from the bootstrap, one with the shipped migrations
// applied by the real command. Test files clone whichever they need.
export default async function setup(project: TestProject) {
  stack();
  const base = newName('base');
  const migrated = newName('migrated');
  await cloneDatabase(BOOTSTRAPPED, base);
  await cloneDatabase(base, migrated);
  const result = await migrate(['migrate', 'up'], { url: urlFor('owner', migrated) });
  project.provide('templates', {
    base,
    migrated,
    migratedError:
      result.code === 0
        ? null
        : `drefyn migrate up on the migrated template exited ${String(result.code)}:\n${result.stderr}`,
  });
  return async () => {
    await dropDatabase(migrated);
    await dropDatabase(base);
  };
}
