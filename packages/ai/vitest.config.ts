import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Token counts from here settle credits, so a gap is a wrong charge.
export default mergeConfig(sharedConfig, {
  test: {
    testTimeout: 30_000,
    coverage: {
      thresholds: {
        lines: 95,
        branches: 90,
      },
    },
  },
});
