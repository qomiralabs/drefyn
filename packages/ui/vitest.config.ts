import { configDefaults, mergeConfig } from 'vitest/config';
import { sharedConfig } from '../../vitest.shared.ts';

// Chart easing has a fallback path that only odd curves reach, so it gets its own floor.
// Component tests run in happy-dom; the rest, and any file that asks for node in its
// header, run in node. The shared include list reaches every project, so each project
// excludes the other's files or every test would run twice.
export default mergeConfig(sharedConfig, {
  test: {
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      thresholds: { 'src/charts.ts': { lines: 95 } },
    },
    projects: [
      {
        test: {
          name: 'node',
          restoreMocks: true,
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, 'test/react/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'dom',
          restoreMocks: true,
          include: ['test/react/**/*.test.{ts,tsx}'],
          exclude: [...configDefaults.exclude, 'test/*.test.ts'],
          environment: 'happy-dom',
        },
      },
    ],
  },
});
