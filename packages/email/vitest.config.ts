import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

export default mergeConfig(sharedConfig, {
  test: {
    // Property tests that render React take far longer inside the full gate, where every
    // package tests at once with coverage.
    testTimeout: 30_000,
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      thresholds: {
        lines: 85,
      },
    },
  },
});
