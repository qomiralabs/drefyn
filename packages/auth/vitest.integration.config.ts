import { defineConfig } from 'vitest/config';

// Each file clones its own database from a template built once per run, so files run in
// parallel against real commits.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    globalSetup: ['test/integration/support/global-setup.ts'],
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
