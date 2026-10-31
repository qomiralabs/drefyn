#!/usr/bin/env node
import { runMigrate } from './run.ts';

process.exitCode = await runMigrate({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
