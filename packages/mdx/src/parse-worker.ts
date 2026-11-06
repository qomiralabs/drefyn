import { serveJobs } from './worker-host.ts';
import { mergePage } from './merge-job.ts';
import { parseForStore } from './parse.ts';
import { printPage } from './print-job.ts';
import type { ThreadJob } from './thread.ts';

// The page, dialect and policy were checked by zod in the parent before they crossed.
function run(job: ThreadJob) {
  if ('tree' in job) return printPage(job);
  if ('trees' in job) return mergePage(job);
  return parseForStore(job.source, job.dialect, job.policy);
}

serveJobs(run);
