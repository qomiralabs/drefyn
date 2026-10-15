import { defineConfig } from 'vitest/config';

export const sharedConfig = defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
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
