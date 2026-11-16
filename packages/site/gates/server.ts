import { createServer, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { breachFrom, buildGateSet, PORT } from './pages.ts';

// Serves the gate pages as a static host would: the policy header, gzip for text, and a
// favicon, so Lighthouse scores the page and not a missing file. Pages are rendered once at
// start, the same way the specs render them, so both agree byte for byte.
const set = buildGateSet(breachFrom(process.env));
const pages = new Map(set.pages.map((page) => [page.path, page]));

const TEXT = /^(?:text\/|application\/json)/;

function send(
  res: ServerResponse,
  gzip: boolean,
  status: number,
  type: string,
  body: Buffer,
  headers: Record<string, string> = {},
) {
  const compress = gzip && TEXT.test(type);
  const payload = compress ? gzipSync(body, { level: 9 }) : body;
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(payload.length),
    'cache-control': 'public, max-age=60',
    'x-content-type-options': 'nosniff',
    ...(compress ? { 'content-encoding': 'gzip', vary: 'accept-encoding' } : {}),
    ...headers,
  });
  res.end(payload);
}

const FAVICON = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>',
);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://gate.invalid');
  const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding']));
  const page = pages.get(url.pathname);
  if (page !== undefined) {
    send(res, gzip, 200, 'text/html; charset=utf-8', Buffer.from(page.html), {
      'content-security-policy': page.csp,
    });
    return;
  }
  const asset = set.assets.get(url.pathname);
  if (asset !== undefined) {
    send(res, gzip, 200, asset.type, asset.body);
  } else if (url.pathname === '/favicon.ico' || url.pathname === '/__ready') {
    send(res, gzip, 200, 'image/svg+xml', FAVICON);
  } else {
    send(res, gzip, 404, 'text/plain; charset=utf-8', Buffer.from('not found'));
  }
}).listen(PORT, '127.0.0.1');
