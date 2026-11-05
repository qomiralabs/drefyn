// The fake provider on loopback, started by the Playwright config beside the dashboard servers.
import { createServer } from 'node:http';
import { createFakeProvider, FAKE_PORT } from './oauth-fake.ts';

const provider = createFakeProvider();

createServer((incoming, outgoing) => {
  const chunks: Buffer[] = [];
  incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
  incoming.on('end', () => {
    const answer = provider.answer({
      method: incoming.method ?? 'GET',
      url: incoming.url ?? '/',
      authorization: incoming.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    outgoing.writeHead(answer.status, answer.headers).end(answer.body);
  });
}).listen(FAKE_PORT, '127.0.0.1');
