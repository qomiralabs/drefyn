import { spawn } from 'node:child_process';

// Stands in for pnpm: it starts the run, and killing it leaves the run with no parent.
const [command = '', ...args] = process.argv.slice(2);
spawn(process.execPath, [command, ...args], { env: process.env, stdio: 'inherit' });
