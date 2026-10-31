import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Every sign in, session and API key goes through this package, so a gap here is a way in.
export default mergeConfig(sharedConfig, {
  test: {
    // Integration tests need the compose Postgres and run under test:integration.
    exclude: ['test/integration/**', '**/node_modules/**'],
    // Property tests that take 0.2 s alone took up to 6 s inside the full gate, where every
    // package tests at once with coverage. 30 s is that loaded maximum times 5.
    testTimeout: 30_000,
    coverage: {
      thresholds: {
        lines: 95,
      },
    },
  },
});
