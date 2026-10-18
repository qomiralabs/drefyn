import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Tenant IDs and cache keys guard isolation, so this package carries the stricter bar.
export default mergeConfig(sharedConfig, {
  test: {
    coverage: {
      thresholds: {
        lines: 95,
      },
    },
  },
});
