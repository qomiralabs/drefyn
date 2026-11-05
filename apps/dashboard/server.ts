// The dashboard's production entry: Node's HTTP server, the client IP wrapper, then Next's
// request handler. Run it with `node server.ts` after `next build`.
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import next from 'next';
import { startExpiryJob } from './src/server/expiry-job.ts';
import { logInfo } from './src/server/log.ts';
import { drainMailer } from './src/server/mail-holder.ts';
import { markClientIpWrapper } from './src/server/wrapper-marker.ts';
import { createWrapper, startWrapper } from './src/server/wrapper.ts';

// Refuses to start on bad wrapper settings, before Next loads anything.
const config = startWrapper(process.env);
// Before Next loads, so its start check and every action reader see that this process
// owns the only listening socket and every request crossed the wrapper.
markClientIpWrapper();

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
// Named, because Next fetches the page after an action redirect from its own idea of this
// server, and that defaults to port 3000.
const app = next({
  dev: false,
  dir: import.meta.dirname,
  hostname,
  port: Number(rawPort),
  httpServer: upgradeStandIn,
});
await app.prepare();
const handle = app.getRequestHandler();

const server = createServer(createWrapper({ config, handle }));
server.listen(Number(rawPort), hostname, () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : Number(rawPort);
  logInfo('dashboard.listening', { port });
});

// Here and not in Next's instrumentation, so it runs only in the production server and stops
// with it. Every server starts one; the database picks who does the work.
const expiryJob = startExpiryJob(process.env);

// Inside compose's default 10 s stop grace.
const MAIL_DRAIN_MS = 8000;

// Lets in flight requests finish on a container stop instead of cutting them off. Mail goes
// out after the response, so it gets its own wait once nothing new can queue.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    expiryJob.stop();
    server.close(() => {
      void drainMailer(MAIL_DRAIN_MS).then(({ dropped }) => {
        if (dropped > 0) logInfo('dashboard.email_dropped', { dropped });
        process.exit(0);
      });
    });
  });
}
