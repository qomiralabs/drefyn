import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Public search is a tenant boundary, so it carries the stricter bar.
export default mergeConfig(sharedConfig, {
  test: {
    exclude: ['test/integration/**'],
    coverage: {
      thresholds: {
        lines: 95,
      },
    },
  },
});
