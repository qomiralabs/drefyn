import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

export default mergeConfig(sharedConfig, {
  test: {
    // These need the compose Postgres and run under test:integration.
    exclude: ['test/**/*.integration.test.ts', '**/node_modules/**'],
  },
});
