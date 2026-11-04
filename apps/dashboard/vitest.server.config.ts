import { defineConfig } from 'vitest/config';

// The wrapper over real loopback sockets, and the built server behind server.ts. CI builds
// the app first; locally, run `pnpm --filter @drefyn/dashboard build` for the built cases.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 30_000,
    hookTimeout: 90_000,
  },
});
