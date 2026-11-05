// First, so nothing the job loads can run before the seal is on.
import './seal-thread.ts';
import { parentPort } from 'node:worker_threads';
import { z } from 'zod';
import type { ThreadJob } from './thread.ts';

const messageSchema = z.object({ id: z.int(), job: z.custom<ThreadJob>() });

export function serveJobs(handle: (job: ThreadJob) => unknown): void {
  const port = parentPort;
  if (port === null) throw new Error('this file runs only inside a worker thread');
  port.on('message', (message: unknown) => {
    const { id, job } = messageSchema.parse(message);
    // A throw here is uncaught on purpose: it ends the thread, and the parent sees a crash.
    void Promise.resolve(handle(job)).then((result) => {
      port.postMessage({ id, result });
    });
  });
  port.postMessage({ ready: true });
}
