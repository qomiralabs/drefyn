import { serveJobs } from '../../../src/worker-host.ts';

// Holds on to memory until the heap cap ends the thread.
const held: string[][] = [];
serveJobs(() => {
  for (;;) held.push(Array.from({ length: 100_000 }, (_, index) => `${index}${held.length}`));
});
