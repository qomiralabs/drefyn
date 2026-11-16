import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runtime } from '../../src/runtime.ts';

export interface Dial {
  readonly address: string;
  readonly port: number;
}

export interface FakeRuntime {
  readonly runtime: Runtime;
  /** Every address the guard asked to connect to, in order. */
  readonly dials: Dial[];
  /** Every name the guard looked up, in order. */
  readonly lookups: string[];
}

// Names resolve from the table, and every dial is recorded and then sent to the loopback
// server on the same port. The recorded address is the one the guard chose, so a test can
// prove where a real connection would have gone without sending a packet anywhere.
export function fakeRuntime(
  names: Readonly<Record<string, readonly string[]>>,
  options: { ca?: Buffer; connect?: (dial: Dial) => Socket } = {},
): FakeRuntime {
  const dials: Dial[] = [];
  const lookups: string[] = [];
  const runtime: Runtime = {
    lookup: (hostname) => {
      lookups.push(hostname);
      const found = names[hostname];
      if (found === undefined) {
        return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
      }
      return Promise.resolve(
        found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
      );
    },
    connect: (address, port) => {
      const dial = { address, port };
      dials.push(dial);
      return options.connect?.(dial) ?? connect({ host: '127.0.0.1', port });
    },
    ...(options.ca === undefined ? {} : { ca: options.ca }),
  };
  return { runtime, dials, lookups };
}

/** A socket that never connects, for connect timeouts. */
export function silentSocket(): Socket {
  return new Socket();
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface Fixture {
  readonly port: number;
  readonly requests: {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
    sni: string | null;
  }[];
  close(): Promise<void>;
}

async function listen(server: Server, handler: Handler): Promise<Fixture> {
  const requests: Fixture['requests'] = [];
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const tls = req.socket as Socket & { servername?: string | false };
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        sni: typeof tls.servername === 'string' ? tls.servername : null,
      });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export function httpFixture(handler: Handler): Promise<Fixture> {
  return listen(createServer(), handler);
}

export interface Certificate {
  readonly key: Buffer;
  readonly cert: Buffer;
}

// A throwaway self signed certificate for one name; a day is far longer than any run.
export function makeCertificate(name: string): Certificate {
  const dir = mkdtempSync(join(tmpdir(), 'egress-tls-'));
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
        `/CN=${name}`,
        '-addext',
        `subjectAltName=DNS:${name}`,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'cert.pem')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function httpsFixture(certificate: Certificate, handler: Handler): Promise<Fixture> {
  return listen(createTlsServer({ key: certificate.key, cert: certificate.cert }), handler);
}
