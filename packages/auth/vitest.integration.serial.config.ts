import { defineConfig } from 'vitest/config';

// Timing budgets, measured alone after the parallel files: those hammer the same database on
// purpose (200 parallel verifies, the lockout scenario), and their load is not what the
// budget is about.
export default defineConfig({
  test: {
    include: ['test/integration/serial/**/*.test.ts'],
    globalSetup: ['test/integration/support/global-setup.ts'],
    fileParallelism: false,
    restoreMocks: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
