import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// The ledger holds what customers paid for, so it carries the stricter bar.
export default mergeConfig(sharedConfig, {
  test: {
    coverage: {
      thresholds: {
        lines: 95,
      },
    },
  },
});
