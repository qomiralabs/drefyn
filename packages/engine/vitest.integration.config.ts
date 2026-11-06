import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    globalSetup: ['test/support/global-setup.ts'],
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
