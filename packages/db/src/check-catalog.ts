#!/usr/bin/env node
import { runCheckCatalog } from './catalog-check.ts';

// Reads the catalog of the database in DREFYN_MIGRATION_DATABASE_URL. Exits 0 when nothing
// weakens tenant isolation and 1 with one line per problem.
process.exitCode = await runCheckCatalog({
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
