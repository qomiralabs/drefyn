import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Focus, keyboard, layout and motion live in the Playwright specs under e2e/.
export default mergeConfig(sharedConfig, {
  test: {
    environment: 'node',
    // Those need real sockets and a build; vitest.server.config.ts runs them.
    exclude: ['test/integration/**', '**/node_modules/**'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/app/**'],
      // Tenant scoping on a read, and the one place handles are built.
      thresholds: {
        'src/server/pages-read.ts': { lines: 95 },
        'src/server/engine-holder.ts': { lines: 95 },
      },
    },
  },
});
