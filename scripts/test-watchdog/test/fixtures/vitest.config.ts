import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../../../vitest.shared.ts';

// The shared config itself, so these prove what every package gets. A test timeout is set low
// on purpose: it cannot stop a sync loop, and a spin must not pass for one that did.
export default mergeConfig(sharedConfig, {
  cacheDir: process.env['FIXTURE_CACHE'] ?? '',
  test: {
    include: [process.env['FIXTURE_FILE'] ?? ''],
    testTimeout: 1_000,
  },
});
