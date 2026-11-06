import { serveJobs } from '../../../src/worker-host.ts';

serveJobs((job) => {
  const text = 'source' in job ? job.source : job.tree;
  console.error(text);
  process.stdout.write(text);
  return { ok: false, error: [] };
});
