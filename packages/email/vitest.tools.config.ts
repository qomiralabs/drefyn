import { defineConfig } from 'vitest/config';

// The preview and the bench render templates, so they run through vitest for its JSX
// transform instead of pulling in a second TypeScript runner.
export default defineConfig({
  test: { include: ['tools/*.run.ts'], testTimeout: 120_000, silent: false },
});
