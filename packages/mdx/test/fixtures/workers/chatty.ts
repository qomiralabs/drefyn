import { serveJobs } from '../../../src/worker-host.ts';

serveJobs((job) => {
  console.error(job.source);
  process.stdout.write(job.source);
  return { ok: false, error: [] };
});
