// First, so it reads the parent before the slow imports below give that parent time to die.
import { stopThenKill, watchParent } from './parent-watch.ts';
import { assertHostEnv, assertHostFlags, parseHostConfig } from './host-config.ts';
import { startParseHost } from './host.ts';
import type { LogFields } from './pool.ts';

// Refused before anything listens: a host missing its boundary must not look healthy.
assertHostFlags(process.execArgv, (path) => process.permission.has('fs.read', path));
assertHostEnv(process.env);

const { pool: config, port, bind, tokenSha256, maxHeldBytes } = parseHostConfig(process.env);
const write = (level: string) => (event: string, fields: LogFields) => {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
};

const host = startParseHost({
  config,
  port,
  bind,
  tokenSha256,
  maxHeldBytes,
  logger: { info: write('info'), warn: write('warn') },
});

// Before anything listens: a stop that lands just after the host says so must still be clean.
process.once('SIGTERM', () => {
  void host
    .then((running) => running.close())
    .then(() => {
      process.exit(0);
    });
});

// Same stop as SIGTERM. Under a live parent this never runs, and with none left nothing else
// would stop this process or enforce the stop.
watchParent(() => {
  stopThenKill(
    () => {
      process.kill(process.pid, 'SIGTERM');
    },
    () => {
      process.kill(process.pid, 'SIGKILL');
    },
  );
  write('warn')('mdx.parse_host_parent_gone', {});
});
