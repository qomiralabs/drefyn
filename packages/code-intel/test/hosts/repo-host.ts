// Stands in for the parse host in its repo role: the same boundary (--permission, no child
// processes, no environment), with files arriving over stdin instead of the wire.
import { createInterface } from 'node:readline';
import { createExtractHost, DEFAULT_EXTRACT_CONFIG } from '../../src/index.ts';
import type { ExtractRequest } from '../../src/index.ts';

const timeoutMs = Number(process.argv[2] ?? DEFAULT_EXTRACT_CONFIG.timeoutMs);
const host = createExtractHost(
  { ...DEFAULT_EXTRACT_CONFIG, timeoutMs },
  {
    logger: { info: () => undefined, warn: () => undefined },
    onStuck: () => {
      process.kill(process.pid, 'SIGKILL');
    },
  },
);

const write = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, request } = JSON.parse(line) as { id: number; request: ExtractRequest };
  void host.extract(request).then((answer) => {
    write({ id, answer });
  });
});

write({
  ready: true,
  permission: {
    child: process.permission.has('child'),
    worker: process.permission.has('worker'),
    passwd: process.permission.has('fs.read', '/etc/passwd'),
  },
});
