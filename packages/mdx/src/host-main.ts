import { assertHostEnv, parseHostConfig } from './host-config.ts';
import { startParseHost } from './host.ts';
import type { LogFields } from './pool.ts';

// Refused before anything listens: a host missing its boundary must not look healthy.
if (!process.execArgv.includes('--permission')) {
  throw new Error('the parse host runs only under --permission');
}
assertHostEnv(process.env);

const { pool: config, port, maxHeldBytes } = parseHostConfig(process.env);
const write = (level: string) => (event: string, fields: LogFields) => {
  process.stdout.write(`${JSON.stringify({ level, event, ...fields })}\n`);
};

await startParseHost({
  config,
  port,
  maxHeldBytes,
  logger: { info: write('info'), warn: write('warn') },
});
