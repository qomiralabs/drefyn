import { mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Focus, keyboard, layout and motion live in the Playwright specs under e2e/.
export default mergeConfig(sharedConfig, {
  test: {
    environment: 'node',
    coverage: { include: ['src/**/*.ts'], exclude: ['src/app/**'] },
  },
});
