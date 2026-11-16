import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// The generator and the filter decoder define the Studio API, so they carry the stricter bar.
export default mergeConfig(sharedConfig, {
  test: {
    // Property tests that take 0.9 s alone took up to 8 s in CI, where every package tests at
    // once with coverage. 30 s is that loaded maximum with room to spare.
    testTimeout: 30_000,
    coverage: {
      thresholds: {
        lines: 95,
      },
    },
  },
});
