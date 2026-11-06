import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import http from 'node:http';
import inspector from 'node:inspector';
import net from 'node:net';
import tls from 'node:tls';
import { Worker } from 'node:worker_threads';
import { serveJobs } from '../../../src/worker-host.ts';

// Each attempt reports only whether it got anywhere. The server in the test counts what
// arrives, so a seal that lies here still fails there.
const attempt = async (open: () => unknown): Promise<'refused' | 'open'> => {
  try {
    await open();
    return 'open';
  } catch {
    return 'refused';
  }
};

const connected = (socket: net.Socket) =>
  new Promise<void>((resolve, reject) => {
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });

serveJobs(async (job) => {
  const port = Number('source' in job ? job.source : '');
  const value = {
    issues: [],
    env: Object.keys(process.env),
    argv: process.argv.slice(2),
    net: await attempt(() => connected(net.connect(port, '127.0.0.1'))),
    tls: await attempt(() => connected(tls.connect(port, '127.0.0.1'))),
    http: await attempt(
      () =>
        new Promise((resolve, reject) => {
          http.get(`http://127.0.0.1:${port}/`, resolve).once('error', reject);
        }),
    ),
    listen: await attempt(() => net.createServer().listen(0)),
    fetch: await attempt(() => globalThis.fetch(`http://127.0.0.1:${port}/`)),
    udp: await attempt(() => {
      dgram.createSocket('udp4').send('x', port, '127.0.0.1');
    }),
    lookup: await attempt(() => dns.promises.lookup('localhost')),
    resolve: await attempt(() => {
      new dns.Resolver().resolve4('localhost', () => undefined);
    }),
    binding: await attempt(() =>
      (process as unknown as { binding(name: string): unknown }).binding('tcp_wrap'),
    ),
    child: await attempt(() => spawn('true').pid ?? Promise.reject(new Error('no child'))),
    spawnSync: await attempt(() => {
      const { error } = spawnSync('true');
      if (error !== undefined) throw error;
    }),
    execSync: await attempt(() => execSync('true')),
    execFileSync: await attempt(() => execFileSync('true')),
    worker: await attempt(() => new Worker('0', { eval: true })),
    inspector: await attempt(() => {
      inspector.open(0, '127.0.0.1');
    }),
    kill: await attempt(() => process.kill(process.pid, 0)),
  };
  return { ok: true, value };
});
