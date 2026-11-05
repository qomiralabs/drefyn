import { defineConfig } from 'vitest/config';

// Apart from the unit suite: a timing budget is a measurement, and a loaded test run would
// turn it into a flake.
export default defineConfig({
  test: { include: ['bench/*.test.ts'], root: '.', testTimeout: 60_000 },
});
