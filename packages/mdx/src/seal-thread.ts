import { ChildProcess } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';

// Worker threads share the process's sockets and Node has no per thread permission for them.
// The parser never needs the network, so a thread gives up these entry points before it reads
// a page. Builtins are per thread, so this changes nothing in the parent. It is a seatbelt and
// not a sandbox: a real no network boundary needs a process and a network policy around it.
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
refuseAll(ChildProcess.prototype, ['spawn']);
refuseAll(process, ['binding', 'dlopen']);

for (const name of ['fetch', 'WebSocket', 'EventSource']) {
  Reflect.deleteProperty(globalThis, name);
}
