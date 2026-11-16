import { parseForStore } from './parse.ts';
import { printPage } from './print-job.ts';
import { readerPage } from './reader.ts';
import type { JobResult } from './result.ts';
import type { ThreadJob } from './thread.ts';

// Reader text comes from the tree this job hands back, so it can never describe another page,
// and it runs here under the same kill as the parse.
export function runJob(job: ThreadJob): JobResult {
  const result =
    'tree' in job ? printPage(job) : parseForStore(job.source, job.dialect, job.policy);
  if (job.reader !== true || !result.ok) return result;
  return {
    ...result,
    value: { ...result.value, reader: readerPage(result.value.ast, job.policy) },
  };
}
