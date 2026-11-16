import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Every hosted plan page reads through this contract, so it carries the money coverage bar.
export default mergeConfig(sharedConfig, {
  test: {
    // Property tests and real sockets slow down when the full gate runs every package at once.
    testTimeout: 30_000,
    coverage: {
      thresholds: {
        lines: 95,
        branches: 95,
      },
    },
  },
});
