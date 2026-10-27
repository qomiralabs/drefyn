import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';
import { INTEGRATION_COVERED } from './vitest.coverage.ts';

// Integration tests need the compose Postgres and run under test:integration instead. Files
// only a real Postgres exercises are measured in the merged run of the e2e database job.
export default mergeConfig(sharedConfig, {
  test: {
    exclude: ['test/integration/**', '**/node_modules/**'],
    coverage: {
      exclude: [...INTEGRATION_COVERED],
    },
  },
});
