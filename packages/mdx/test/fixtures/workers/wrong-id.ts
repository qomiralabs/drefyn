import { parentPort } from 'node:worker_threads';

// Stands in for a thread that answers some other job, or answers nonsense.
parentPort?.on('message', ({ id, job }: { id: number; job: { source: string } }) => {
  const answer =
    job.source === 'malformed'
      ? { id, result: { ok: true, value: {} } }
      : { id: -1, result: { ok: false, error: [] } };
  parentPort?.postMessage(answer);
});
parentPort?.postMessage({ ready: true });
