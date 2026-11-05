import childProcess, { ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import inspector from 'node:inspector';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import workerThreads from 'node:worker_threads';

// A seatbelt, not a boundary. Code that already runs in a thread has other ways out, and a
// thread shares its process. The boundary is the parse host: --permission, no credentials,
// and a network the platform closes. This only takes away what a parser never needs, in this
// thread alone, since builtins are per thread.
const refuse = (): never => {
  throw new Error('the parse thread has no network');
};

function refuseAll(target: object, names: readonly string[]) {
  for (const name of names) {
    Object.defineProperty(target, name, { value: refuse, writable: false, configurable: false });
  }
}

const functionsOf = (target: object) =>
  Reflect.ownKeys(target).filter(
    (key): key is string =>
      typeof key === 'string' &&
      key !== 'constructor' &&
      typeof Object.getOwnPropertyDescriptor(target, key)?.value === 'function',
  );

// Every client in Node, http, tls and fetch included, ends in one of these.
refuseAll(net.Socket.prototype, ['connect']);
refuseAll(net.Server.prototype, ['listen']);
refuseAll(dgram.Socket.prototype, ['bind', 'send', 'connect']);
// Resolver is one of these, so a new one cannot be built either.
refuseAll(dns, functionsOf(dns));
refuseAll(dns.promises, functionsOf(dns.promises));
// A new thread would start with none of this.
refuseAll(workerThreads, ['Worker']);
refuseAll(inspector, ['open']);
refuseAll(ChildProcess.prototype, ['spawn']);
// The sync family goes straight to a binding, so it never reaches the prototype above.
refuseAll(childProcess, [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);
refuseAll(process, ['binding', 'dlopen', 'kill']);

for (const name of ['fetch', 'WebSocket', 'EventSource']) {
  Reflect.deleteProperty(globalThis, name);
}

// Named imports read a snapshot of the module until this runs.
syncBuiltinESMExports();
