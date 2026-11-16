import { readFileSync } from 'node:fs';
import type { ThreadJob } from '../../../src/thread.ts';
import { serveJobs } from '../../../src/worker-host.ts';

const denied = (open: () => unknown) => {
  try {
    open();
    return 'read';
  } catch (error) {
    return (error as { code?: string }).code ?? 'failed';
  }
};

// A page that is a number holds the thread that long first, as a host too loaded to run it
// would, so a test can show the probe's answer does not hang on the machine's load.
const held = new Int32Array(new SharedArrayBuffer(4));
const hold = (job: ThreadJob) => {
  const ms = 'source' in job && /^[0-9]{1,5}$/.test(job.source.trim()) ? Number(job.source) : 0;
  if (ms > 0) Atomics.wait(held, 0, 0, ms);
};

// An answer with no tree, as the client checks every tree. The code carries what came back.
serveJobs((job) => {
  hold(job);
  const file = denied(() => readFileSync('/etc/hosts'));
  const environ = denied(() => readFileSync('/proc/self/environ'));
  const secrets = denied(() => readFileSync('/run/secrets/postgres_password'));
  const code = `mdx.probe:${file}:${environ}:${secrets}:${String(Object.keys(process.env).length)}`;
  return { ok: false, error: [{ code, severity: 'error', line: 1, column: 1 }] };
});
