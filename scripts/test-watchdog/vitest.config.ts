import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// The fixtures start a whole vitest of their own.
export default mergeConfig(sharedConfig, { test: { testTimeout: 60_000 } });
