import { serveJobs } from '../../../src/worker-host.ts';

serveJobs((job) => {
  throw new Error(job.source);
});
