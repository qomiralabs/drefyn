import { defineConfig } from 'vitest/config';

// Run by scripts/email-integration.sh, which starts Mailpit and passes the certificates.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    restoreMocks: true,
    // The files share four Mailpit inboxes and count what lands in them.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
