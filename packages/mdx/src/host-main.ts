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

const host = await startParseHost({
  config,
  port,
  bind,
  tokenSha256,
  maxHeldBytes,
  logger: { info: write('info'), warn: write('warn') },
});

process.once('SIGTERM', () => {
  void host.close().then(() => {
    process.exit(0);
  });
});
