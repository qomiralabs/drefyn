import { defineConfig } from 'vitest/config';

// Stryker works on a copy of this package, where the shared config is out of reach. The corpus
// and generated suites take minutes a mutant; these take seconds and hold the exact bytes, so
// a survivor is a gap in what the printer is pinned to.
export default defineConfig({
  test: {
    include: [
      'test/print-canonical.test.ts',
      'test/held-bytes.test.ts',
      'test/meaning.test.ts',
      'test/print-job.test.ts',
      'test/serialize.test.ts',
      'test/merge-diff.test.ts',
      'test/merge3.test.ts',
      'test/merge3.hostile.test.ts',
      'test/merge-align.test.ts',
      'test/merge-nodes.test.ts',
    ],
    restoreMocks: true,
  },
});
