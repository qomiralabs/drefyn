import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// These suites spawn git. On a loaded machine a single spawn can take seconds, so the
// fixture hooks and the tests get room well beyond the 5 s and 10 s defaults.
export default mergeConfig(sharedConfig, {
  test: {
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
