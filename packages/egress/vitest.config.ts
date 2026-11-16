import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Every outbound request a customer can aim goes through this package, so a gap is a way in.
export default mergeConfig(sharedConfig, {
  test: {
    // Property tests slow down a lot when the full gate runs every package at once.
    testTimeout: 30_000,
    coverage: {
      thresholds: {
        lines: 95,
        branches: 95,
      },
    },
  },
});
