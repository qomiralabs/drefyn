#!/usr/bin/env node
import { runDrefyn } from './index.ts';

process.exitCode = await runDrefyn({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
});
