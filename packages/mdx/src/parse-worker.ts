import { serveJobs } from './worker-host.ts';
import { runJob } from './jobs.ts';

// The page, dialect and policy were checked by zod in the parent before they crossed.
serveJobs(runJob);
