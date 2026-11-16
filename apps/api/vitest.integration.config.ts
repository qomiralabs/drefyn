import { defineConfig } from 'vitest/config';
import { watchdogGlobalSetup, watchdogSetup } from '../../vitest.shared.ts';

// Each file clones its own database from a template migrated once per run.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: [watchdogGlobalSetup, 'test/integration/support/global-setup.ts'],
    restoreMocks: true,
    setupFiles: [watchdogSetup],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
