import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Every request to /v1 crosses the key checks here, so this is held to the bar auth is held to.
export default mergeConfig(sharedConfig, {
  test: {
    environment: 'node',
    // Those need the compose stack; vitest.integration.config.ts runs them.
    exclude: ['test/integration/**', '**/node_modules/**'],
    coverage: { thresholds: { lines: 95 } },
  },
});
