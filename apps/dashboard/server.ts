// The dashboard's production entry: Node's HTTP server, the client IP wrapper, then Next's
// request handler. Run it with `node server.ts` after `next build`.
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import next from 'next';
import { logInfo } from './src/server/log.ts';
import { createWrapper, startWrapper } from './src/server/wrapper.ts';

// Refuses to start on bad wrapper settings, before Next loads anything.
const config = startWrapper(process.env);

const rawPort = process.env['PORT'] ?? '3000';
if (!/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) > 65_535) {
  throw new Error('PORT must be a whole number from 0 to 65535');
}
const hostname = process.env['HOSTNAME'] ?? '0.0.0.0';

// On the first routed request Next adds its own upgrade listener to the server it is given,
// or else to the request's socket's server. That listener skips the wrapper and leaves the
// socket open, which also blocks shutdown. Given this stand in it adds it here, where nothing
// ever fires. The dashboard has no WebSocket route, so with no listener on the real server
// Node treats an upgrade as an ordinary request and the wrapper answers it.
const upgradeStandIn = new EventEmitter() as unknown as Server;
const app = next({ dev: false, dir: import.meta.dirname, httpServer: upgradeStandIn });
await app.prepare();
const handle = app.getRequestHandler();

const server = createServer(createWrapper({ config, handle }));
server.listen(Number(rawPort), hostname, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : Number(rawPort);
  logInfo('dashboard.listening', { port });
});

// Lets in flight requests finish on a container stop instead of cutting them off.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
