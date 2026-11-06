import { parentPort } from 'node:worker_threads';

// A V8 fatal in a thread takes its whole process with SIGABRT. No page is known to reach one,
// so this raises the same signal on the host. Not sealed, because the seal would refuse it.
parentPort?.on('message', () => {
  process.kill(process.pid, 'SIGABRT');
});
parentPort?.postMessage({ ready: true });
