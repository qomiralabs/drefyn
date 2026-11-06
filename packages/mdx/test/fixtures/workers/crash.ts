import { serveJobs } from '../../../src/worker-host.ts';

serveJobs((job) => {
  throw new Error('source' in job ? job.source : job.tree);
});
