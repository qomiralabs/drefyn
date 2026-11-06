import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import inspector from 'node:inspector';
import net from 'node:net';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import '../src/seal-thread.ts';

// Each test file has its own process, so turning the network off here reaches nothing else.
describe('the seal', () => {
  it.each([
    ['a socket', () => net.connect(1, '127.0.0.1')],
    ['a server', () => net.createServer().listen(0)],
    [
      'udp',
      () => {
        dgram.createSocket('udp4').send('x', 1, '127.0.0.1');
      },
    ],
    [
      'a lookup',
      () => {
        dns.lookup('localhost', () => undefined);
      },
    ],
    ['a promised lookup', () => dns.promises.lookup('localhost')],
    ['a resolver', () => new dns.Resolver()],
    ['a child process', () => spawn('true')],
    ['spawnSync, which never passes through spawn', () => spawnSync('true')],
    ['execSync', () => execSync('true')],
    ['execFileSync', () => execFileSync('true')],
    ['exec', () => exec('true')],
    ['execFile', () => execFile('true')],
    ['fork', () => fork('x')],
    ['an unsealed thread', () => new Worker('0', { eval: true })],
    ['a debugger port', () => inspector.open(0, '127.0.0.1')],
    ['a signal to the host', () => process.kill(process.pid, 0)],
    [
      'the same signal by its private name',
      () =>
        (process as unknown as { _kill: (pid: number, signal: number) => void })._kill(
          process.pid,
          0,
        ),
    ],
    ['a report that prints the environment', () => process.report.getReport()],
    [
      'a native binding',
      () => {
        process.dlopen({ exports: {} }, 'x');
      },
    ],
  ])('refuses %s', (_name, open) => {
    expect(open).toThrow();
  });

  it('takes the network globals away', () => {
    expect(globalThis.fetch).toBeUndefined();
    expect(globalThis.WebSocket).toBeUndefined();
  });

  it('cannot be undone by assignment', () => {
    expect(Reflect.set(net.Socket.prototype, 'connect', () => undefined)).toBe(false);
  });
});
