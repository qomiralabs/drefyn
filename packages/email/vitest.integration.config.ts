import { defineConfig } from 'vitest/config';
import { watchdogGlobalSetup, watchdogSetup } from '../../vitest.shared.ts';

// Run by scripts/email-integration.sh, which starts Mailpit and passes the certificates.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    restoreMocks: true,
    setupFiles: [watchdogSetup],
    globalSetup: [watchdogGlobalSetup],
    // The files share four Mailpit inboxes and count what lands in them.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
