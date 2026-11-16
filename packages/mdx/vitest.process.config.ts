import { defineConfig } from 'vitest/config';
import { watchdogGlobalSetup, watchdogSetup } from '../../vitest.shared.ts';

// Kept out of the package's test run, and started one file at a time after it. These start whole
// test runs and real hosts, and the CPU that takes would land on the time window tests.
export default defineConfig({
  test: {
    include: ['test/*.process.ts'],
    fileParallelism: false,
    restoreMocks: true,
    setupFiles: [watchdogSetup],
    globalSetup: [watchdogGlobalSetup],
  },
});
