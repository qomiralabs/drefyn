import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// The key, the tokens and the webhook check guard every customer repository, so the stricter
// bar. The two stores are SQL and only mean anything against a real Postgres, so the
// integration run holds them to the same bar instead.
export default mergeConfig(sharedConfig, {
  test: {
    exclude: ['test/integration/**', '**/node_modules/**'],
    testTimeout: 30_000,
    coverage: {
      exclude: ['src/installations.ts', 'src/ledger.ts'],
      thresholds: { lines: 95, branches: 95 },
    },
  },
});
