// A global under a registered symbol, because server.ts and the bundled server code load
// separate copies of this module and share only the process. No request and no env var can
// reach it, so its presence proves this process started through the client IP wrapper.
const MARKER = Symbol.for('drefyn.client_ip_wrapper');

export function markClientIpWrapper(): void {
  Object.defineProperty(globalThis, MARKER, {
    value: true,
    writable: false,
    configurable: false,
  });
}

export function clientIpWrapperRunning(): boolean {
  return Object.getOwnPropertyDescriptor(globalThis, MARKER)?.value === true;
}
