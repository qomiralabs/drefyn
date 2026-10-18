// Code that touches the names without making a raw outbound call.
import type { IncomingMessage } from 'node:http';
import type * as Undici from 'undici';
import { readFile } from 'node:fs/promises';
import { guardedFetch as fetch } from '@drefyn/egress';

export interface Options {
  fetch?: typeof fetch;
  request?: IncomingMessage;
  agent?: Undici.Agent;
  socket?: typeof globalThis.WebSocket;
}

export function call(options: Options) {
  const client = { fetch: () => 1 };
  return [fetch('https://example.com'), client.fetch(), options.fetch, readFile];
}

export function shadowed(WebSocket: new (url: string) => object) {
  const globalThis = { fetch: () => 2 };
  return [new WebSocket('wss://example.com'), globalThis.fetch()];
}
