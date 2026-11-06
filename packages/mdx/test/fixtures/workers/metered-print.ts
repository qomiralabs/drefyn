import { printPage } from '../../../src/print-job.ts';
import { serveJobs } from '../../../src/worker-host.ts';

serveJobs((job) => {
  if (!('tree' in job)) throw new Error('prints only');
  const before = process.threadCpuUsage();
  const result = printPage(job);
  const { user, system } = process.threadCpuUsage(before);
  const cpuMs = (user + system) / 1_000;
  return { ok: result.ok, value: { issues: [], cpuMs, printed: result.ok } };
});
