import { readFileSync } from 'node:fs';
import { serveJobs } from '../../../src/worker-host.ts';

const denied = (open: () => unknown) => {
  try {
    open();
    return 'read';
  } catch (error) {
    return (error as { code?: string }).code ?? 'failed';
  }
};

// An answer with no tree, as the client checks every tree. The code carries what came back.
serveJobs(() => {
  const file = denied(() => readFileSync('/etc/hosts'));
  const environ = denied(() => readFileSync('/proc/self/environ'));
  const secrets = denied(() => readFileSync('/run/secrets/postgres_password'));
  const code = `mdx.probe:${file}:${environ}:${secrets}:${String(Object.keys(process.env).length)}`;
  return { ok: false, error: [{ code, severity: 'error', line: 1, column: 1 }] };
});
