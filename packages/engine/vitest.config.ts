import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

export default mergeConfig(sharedConfig, {
  test: {
    // The public read path is a security boundary, held to the tenancy bar.
    coverage: { thresholds: { 'src/published.ts': { lines: 95 } } },
    // These need the compose Postgres and run under test:integration.
    exclude: [
      'test/**/*.integration.test.ts',
      'test/integration/**',
      'test/versions.property.test.ts',
      '**/node_modules/**',
    ],
  },
});
