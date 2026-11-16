import { defineConfig } from 'vitest/config';
import { watchdogGlobalSetup, watchdogSetup } from '../../vitest.shared.ts';

// Each file starts a whole vitest of its own, so these run apart from the package's tests.
export default defineConfig({
  test: {
    include: ['test/*.process.ts'],
    fileParallelism: false,
    restoreMocks: true,
    testTimeout: 60_000,
    setupFiles: [watchdogSetup],
    globalSetup: [watchdogGlobalSetup],
  },
});
