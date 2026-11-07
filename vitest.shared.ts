import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// A config that cannot extend the shared one still lists this, so no test run goes without it.
export const watchdogSetup = fileURLToPath(
  new URL('./scripts/test-watchdog/src/setup.ts', import.meta.url),
);

export const sharedConfig = defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    setupFiles: [watchdogSetup],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 85,
      },
    },
  },
});
