import { defineConfig } from 'vitest/config';

// Each file gets its own database cloned from a template, so files run in parallel against
// real commits. The templates are built once per run in the global setup.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    // Role settings are cluster wide; vitest.integration.serial.config.ts runs these alone.
    exclude: ['test/integration/serial/**', '**/node_modules/**'],
    globalSetup: ['test/integration/support/global-setup.ts'],
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
