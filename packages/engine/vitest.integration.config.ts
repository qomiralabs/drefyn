import { defineConfig } from 'vitest/config';
import { watchdogGlobalSetup, watchdogSetup } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts', 'test/versions.property.test.ts'],
    globalSetup: [watchdogGlobalSetup, 'test/support/global-setup.ts'],
    restoreMocks: true,
    setupFiles: [watchdogSetup],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
