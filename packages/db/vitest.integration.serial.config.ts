import { defineConfig } from 'vitest/config';

// Files here change cluster wide role settings and attributes, so they run one at a time and
// only after the parallel files have finished.
export default defineConfig({
  test: {
    include: ['test/integration/serial/**/*.test.ts'],
    globalSetup: ['test/integration/support/global-setup.ts'],
    fileParallelism: false,
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
