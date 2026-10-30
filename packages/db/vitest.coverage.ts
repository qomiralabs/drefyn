// Shared by the unit config and the merged coverage run in the e2e database job.

// Tenancy files, held to 95 percent lines and branches in the merged run.
export const TENANCY_FILES: readonly string[] = [
  'src/database.ts',
  'src/tenant-sql.ts',
  'src/tenant-context.ts',
  'src/role-check.ts',
  'src/catalog-check.ts',
  'src/source-check.ts',
  'src/pg-errors.ts',
  'src/config.ts',
  'src/integers.ts',
  'src/new-id.ts',
  'src/rate-windows.ts',
  'src/expiry-cleanup.ts',
  'src/identity-columns.ts',
  'src/allow-lists.ts',
];

// Files only a real Postgres exercises. The unit run excludes exactly these, and each one is
// a tenancy file, so leaving the unit run always means the 95 percent bar in the merged run.
export const INTEGRATION_COVERED: readonly string[] = [
  'src/database.ts',
  'src/catalog-check.ts',
  'src/rate-windows.ts',
  'src/expiry-cleanup.ts',
];
