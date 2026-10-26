#!/usr/bin/env node
import { runCheckTypes } from './types-check.ts';

// Migrates the empty database in DREFYN_MIGRATION_DATABASE_URL and compares its tables with
// the committed types. Exits 0 when they match and 1 naming each table that differs.
process.exitCode = await runCheckTypes({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
