import { defineConfig } from 'vitest/config';

// Each file clones its own database from a template built once per run, so files run in
// parallel against real commits.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // Timing runs alone afterwards, in vitest.integration.serial.config.ts.
    exclude: ['test/integration/serial/**', '**/node_modules/**'],
    globalSetup: ['test/integration/support/global-setup.ts'],
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
