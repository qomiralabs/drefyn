// Shaped like the dashboard's inbound server: it listens, it never calls out.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import next from 'next';

const app = next({ dev: false });
const handle = app.getRequestHandler();

export async function start(port: number) {
  await app.prepare();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res);
  });
  server.listen(port, '127.0.0.1');
  return server;
}
