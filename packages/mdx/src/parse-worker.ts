import { serveJobs } from './worker-host.ts';
import { parseForStore } from './parse.ts';
import { printPage } from './print-job.ts';

// The page, dialect and policy were checked by zod in the parent before they crossed.
serveJobs((job) =>
  'tree' in job ? printPage(job) : parseForStore(job.source, job.dialect, job.policy),
);
