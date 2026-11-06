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
      'test/merge3.property.test.ts',
    ],
    // A slice on one seed: a merge is judged on what it keeps, which generated edits show best,
    // and a mutant has to be caught the same way on every run.
    env: { MERGE_PROPERTY_RUNS: '400', MERGE_PROPERTY_SEED: '20261106' },
    restoreMocks: true,
  },
});
