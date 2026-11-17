import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly body: string;
}

export interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export type FakeHandler = (request: Recorded) => Reply;

export interface FakeGitHub {
  readonly apiUrl: string;
  readonly requests: Recorded[];
  handle(handler: FakeHandler): void;
  close(): Promise<void>;
}

// A certificate for the loopback address itself, trusted by this test process only. The
// guard dials 127.0.0.1 and checks the certificate against it, as it would api.github.com.
function loopbackCertificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'drefyn-github-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// GitHub's API on loopback over TLS. Every request is recorded and answered by the current
// handler; the default answers 404 like GitHub does for anything it does not know.
export async function startFakeGitHub(): Promise<FakeGitHub> {
  const { key, cert } = loopbackCertificate();
  setDefaultCACertificates([...getCACertificates('default'), cert.toString()]);
  const requests: Recorded[] = [];
  let handler: FakeHandler = () => ({ status: 404, body: { message: 'Not Found' } });
  const server = createServer({ key, cert }, (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const reply = handler(recorded);
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    apiUrl: `https://127.0.0.1:${String(address.port)}`,
    requests,
    handle: (next) => {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
