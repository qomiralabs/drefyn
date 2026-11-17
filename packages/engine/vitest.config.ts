import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

export default mergeConfig(sharedConfig, {
  test: {
    // The public read path is a security boundary, held to the tenancy bar.
    // So is the publish gate, the one place a human review is enforced, and the chunk copy it
    // writes, which decides what the public reader can rank. Visibility decides what is public
    // at all.
    coverage: {
      thresholds: {
        'src/published.ts': { lines: 95 },
        'src/publish.ts': { lines: 95 },
        'src/publish-rules.ts': { lines: 95 },
        'src/published-chunks.ts': { lines: 95 },
        'src/visibility.ts': { lines: 95 },
      },
    },
    // These need the compose Postgres and run under test:integration.
    exclude: [
      'test/**/*.integration.test.ts',
      'test/integration/**',
      'test/versions.property.test.ts',
      'test/visibility.property.test.ts',
      '**/node_modules/**',
    ],
  },
});
