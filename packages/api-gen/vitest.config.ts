import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// The generator and the filter decoder define the Studio API, so they carry the stricter bar.
export default mergeConfig(sharedConfig, {
  test: {
    coverage: {
      thresholds: {
        lines: 95,
      },
    },
  },
});
