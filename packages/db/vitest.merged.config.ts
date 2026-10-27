import { defineConfig } from 'vitest/config';
import { TENANCY_FILES } from './vitest.coverage.ts';

// Merges the blobs the unit, integration and serial runs leave in coverage/blobs (see the
// test:merged script). Some tenancy files only run against a real Postgres, so only the
// merged numbers can hold them to 95 percent.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage/merged',
      thresholds: {
        lines: 85,
        // One entry per file, so a well covered file cannot hide a weak one.
        ...Object.fromEntries(TENANCY_FILES.map((file) => [file, { lines: 95, branches: 95 }])),
      },
    },
  },
});
