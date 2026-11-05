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

serveJobs(() => ({
  ok: true,
  value: {
    issues: [],
    ast: { file: denied(() => readFileSync('/etc/hosts')), env: Object.keys(process.env) },
  },
}));
