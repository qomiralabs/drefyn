import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Every limit in every product reads this package, so a gap here is a billing bug.
export default mergeConfig(sharedConfig, {
  test: {
    coverage: {
      thresholds: {
        lines: 95,
      },
    },
  },
});
