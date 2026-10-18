import { configDefaults, mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Fixture packages have their own test/ folders; they are inputs, not suites. ESLint and
// tsc runs in the template test take a few seconds on a cold machine.
export default mergeConfig(sharedConfig, {
  test: {
    exclude: [...configDefaults.exclude, 'test/fixtures/**'],
    testTimeout: 60_000,
  },
});
