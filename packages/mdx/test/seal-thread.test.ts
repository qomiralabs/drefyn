import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
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
