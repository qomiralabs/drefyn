import { defineConfig } from 'vitest/config';
import { watchdogGlobalSetup, watchdogSetup } from '../../vitest.shared.ts';

// Runs against the Typesense of the compose stack, started with COMPOSE_PROFILES=search.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: [watchdogGlobalSetup],
    restoreMocks: true,
    setupFiles: [watchdogSetup],
    // The files share one Typesense and its key list, so they run one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
