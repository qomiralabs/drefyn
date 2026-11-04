// The one trusted hop for the lockout specs: TLS on loopback in front of the wrapper, as a
// real proxy would be. The spec names the client it stands for in a test header, and the
// proxy turns that into the X-Forwarded-For a real hop would write. It belongs to the tests:
// the wrapper under it runs with hops 1 and a non loopback origin, exactly as in production.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request as forward } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLIENT_HEADER = 'x-test-client';

const [listen, target, name] = process.argv.slice(2).map(String);
if (listen === undefined || target === undefined || name === undefined) {
  throw new Error('usage: hop-proxy <listen port> <wrapper port> <host name>');
}

const directory = mkdtempSync(join(tmpdir(), 'hop-'));
const [key, cert] = [join(directory, 'key.pem'), join(directory, 'cert.pem')];
const made = spawnSync('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-days',
  '1',
  '-subj',
  `/CN=${name}`,
  '-keyout',
  key,
  '-out',
  cert,
]);
if (made.status !== 0) throw new Error('openssl could not make the test certificate');

createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const client = req.headers[CLIENT_HEADER];
  const headers = { ...req.headers };
  Reflect.deleteProperty(headers, CLIENT_HEADER);
  headers['x-forwarded-for'] = typeof client === 'string' ? client : '192.0.2.1';
  const upstream = forward(
    { host: '127.0.0.1', port: Number(target), method: req.method, path: req.url, headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    },
  );
  upstream.on('error', () => {
    res.writeHead(502).end();
  });
  req.pipe(upstream);
}).listen(Number(listen), '127.0.0.1');
