import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Chart easing has a fallback path that only odd curves reach, so it gets its own floor.
export default mergeConfig(sharedConfig, {
  test: { coverage: { thresholds: { 'src/charts.ts': { lines: 95 } } } },
});
