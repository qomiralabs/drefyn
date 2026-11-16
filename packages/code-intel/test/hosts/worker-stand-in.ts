// A worker that misbehaves the way workerData says, to drive every branch of the thread.
import { parentPort, workerData } from 'node:worker_threads';

const port = parentPort;
if (port === null) throw new Error('this file runs only inside a worker thread');
const mode = String(workerData);

if (mode !== 'never-ready') port.postMessage({ ready: true });
port.on('message', (message: { id: number }) => {
  if (mode === 'wrong-shape') port.postMessage({ id: message.id, result: { symbols: 'no' } });
  if (mode === 'wrong-id')
    port.postMessage({ id: message.id + 1, result: { symbols: [], routes: [], partial: false } });
  if (mode === 'crash') throw new Error('boom');
  if (mode === 'exit') process.exit(3);
  if (mode === 'oom') {
    const hold: string[] = [];
    for (;;) hold.push('x'.repeat(1_000_000) + String(hold.length));
  }
});
