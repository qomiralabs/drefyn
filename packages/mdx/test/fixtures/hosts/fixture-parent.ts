import { spawn } from 'node:child_process';

// A parent to kill. The test holds the output of whatever this starts, so it still reads what
// the child says once this is gone.
const [command = '', ...args] = process.argv.slice(2);
spawn(command, args, { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });
