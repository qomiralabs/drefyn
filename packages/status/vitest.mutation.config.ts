import { defineConfig } from 'vitest/config';

// Stryker works on a copy of this package, where the shared config is out of reach. The
// replay and drain runs are left out: they take seconds per mutant and pin outcomes the unit
// and property tests already pin per rule.
export default defineConfig({
  test: {
    include: [
      'test/evaluate.test.ts',
      'test/evaluate.property.test.ts',
      'test/default-min-regions.property.test.ts',
      'test/defaults.test.ts',
    ],
    restoreMocks: true,
    setupFiles: ['@drefyn/test-watchdog/setup'],
    globalSetup: ['@drefyn/test-watchdog/global-setup'],
  },
});
