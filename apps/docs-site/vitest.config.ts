import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// The host decides whose pages go out, so this app is held to the bar tenancy is held to.
export default mergeConfig(sharedConfig, {
  test: {
    environment: 'node',
    coverage: { thresholds: { lines: 95 } },
  },
});
