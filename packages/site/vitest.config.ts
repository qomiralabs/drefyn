import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// The determinism properties run hundreds of renders through development React under coverage,
// which took a CI runner past the 5 s default.
export default mergeConfig(sharedConfig, { test: { testTimeout: 30_000 } });
