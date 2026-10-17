// Every raw way out. The test lints this same text inside and outside packages/egress.
import http from 'node:http';
import https from 'https';
import * as http2 from 'node:http2';
import { connect } from 'net';
import tls from 'node:tls';
import dgram from 'dgram';
import { lookup } from 'node:dns';
import dns from 'dns/promises';
import { request } from 'undici';
export { Agent } from 'undici/lib/dispatcher/agent.js';
export * from 'node:https';
export const lazy = () => import('node:net');
export const required = require('http');
export const fromFetch = fetch('https://example.com');
export const fromGlobal = globalThis.fetch('https://example.com');
export const fromComputed = globalThis['fetch'];
export const socket = new WebSocket('wss://example.com');
export const passed = [fetch];
export const all = [http, https, http2, connect, tls, dgram, lookup, dns, request] as const;
import legacyNet = require('node:net');
import type legacyHttp = require('node:http');
export { legacyNet, type legacyHttp };
import bareTls from 'tls';
import udp from 'node:dgram';
import { resolve4 } from 'dns';
export const { fetch: grabbed } = globalThis;
export const nested = globalThis.globalThis.fetch;
export const builtin = process.getBuiltinModule('node:http');
import { createRequire } from 'node:module';
export const viaCreate = createRequire(import.meta.url)('node:https');
const load = createRequire(import.meta.url);
export const viaVariable = load('net');
import { ClientRequest } from '_http_client';
export const viaModule = module.require('node:tls');
export const more = [bareTls, udp, resolve4, ClientRequest] as const;
let assigned: unknown;
({ WebSocket: assigned } = globalThis);
export function withDefault({ fetch: given } = globalThis) {
  return [given, assigned];
}
export const {
  globalThis: { fetch: inner },
} = globalThis;
export const viaRequire = [
  require('_http_agent'),
  require('node:_tls_wrap'),
  require('_stream_wrap'),
];
