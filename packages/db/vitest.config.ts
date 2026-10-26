import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Integration tests need the compose Postgres and run under test:integration instead.
export default mergeConfig(sharedConfig, {
  test: {
    exclude: ['test/integration/**', '**/node_modules/**'],
  },
});
