import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// The agent read path is a tenant boundary, so it carries the stricter bar.
export default mergeConfig(sharedConfig, {
  test: {
    // These need the compose Postgres and run under test:integration.
    exclude: ['test/integration/**', '**/node_modules/**'],
    coverage: {
      thresholds: {
        lines: 95,
      },
    },
  },
});
