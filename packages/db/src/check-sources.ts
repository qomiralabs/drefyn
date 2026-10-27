#!/usr/bin/env node
import { runCheckSources } from './source-check.ts';

// Fails on extension DDL in migrations and on session scoped tenant settings anywhere.
process.exitCode = runCheckSources({
  argv: process.argv.slice(2),
  stdout: process.stdout,
  stderr: process.stderr,
});
