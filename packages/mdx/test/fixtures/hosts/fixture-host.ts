import { watchParent } from '../../../src/parent-watch.ts';
import { startParseHost } from '../../../src/host.ts';
import { parsePoolConfig } from '../../../src/pool-config.ts';
import { startParseThread } from '../../../src/thread.ts';

// A real host, killing itself for real, with a test script on its threads.
const script = new URL(`../workers/${process.argv[2] ?? ''}.ts`, import.meta.url);
const config = parsePoolConfig({
  DREFYN_PARSE_TIMEOUT_MS: '200',
  DREFYN_PARSE_KILL_GRACE_MS: '300',
});
await startParseHost({
  config,
  port: 0,
  bind: '127.0.0.1',
  tokenSha256: process.env['DREFYN_PARSE_TOKEN_SHA256'] ?? '',
  logger: { warn: () => undefined },
  startThread: () => startParseThread(script, config),
});
watchParent(() => {
  process.kill(process.pid, 'SIGKILL');
});
