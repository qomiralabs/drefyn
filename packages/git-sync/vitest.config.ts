import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Tenancy code, so the stricter bar. The store is SQL and only means anything against a real
// Postgres, so its coverage is held to the same bar by the integration run instead.
export default mergeConfig(sharedConfig, {
  test: {
    exclude: ['test/integration/**', '**/node_modules/**'],
    coverage: {
      exclude: ['src/store.ts'],
      thresholds: { lines: 95 },
    },
  },
});
