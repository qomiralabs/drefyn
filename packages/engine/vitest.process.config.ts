import { defineConfig } from 'vitest/config';
import { watchdogGlobalSetup, watchdogSetup } from '../../vitest.shared.ts';

// Kept out of the package's test run, and started one file at a time after every package's
// tests. These start a real parse host and parse the whole corpus, and beside the other suites
// under coverage that work got a few percent of the CPU and passed its hook budget.
export default defineConfig({
  test: {
    include: ['test/*.process.ts'],
    fileParallelism: false,
    restoreMocks: true,
    setupFiles: [watchdogSetup],
    globalSetup: [watchdogGlobalSetup],
  },
});
