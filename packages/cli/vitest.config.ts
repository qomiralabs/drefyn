import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// The binary prints sign in links and runs migrations as the owner, so it is held to the
// auth bar even though it only dispatches.
export default mergeConfig(sharedConfig, {
  test: {
    // Spawns node several times; slow under the full gate.
    testTimeout: 30_000,
    coverage: {
      // Only process wiring; the spawn tests run it, but child coverage is not counted.
      exclude: ['src/main.ts'],
      thresholds: {
        lines: 95,
      },
    },
  },
});
