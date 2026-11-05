import { execSync } from 'node:child_process';
import { parentPort } from 'node:worker_threads';

// Blocks in native code with no CPU use, which terminate cannot interrupt. Not sealed, because
// the seal would refuse the stall. It ends by itself, so nothing outlives the test for long.
parentPort?.on('message', () => {
  execSync('sleep 4');
});
parentPort?.postMessage({ ready: true });
