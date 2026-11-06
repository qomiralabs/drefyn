import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { TenantRef } from '@drefyn/tenancy';
import { createHeldBytes, DEFAULT_MAX_HELD_BYTES } from './held-bytes.ts';
import type { HeldBytes, HeldClaim } from './held-bytes.ts';
import { DEFAULT_LIMITS } from './policy.ts';
import { createParsePool } from './pool.ts';
import type { ParseLogger, ParsePool } from './pool.ts';
import type { ParsePoolConfig } from './pool-config.ts';
import type { ParseThread } from './thread.ts';
import { refused } from './result.ts';
import type { JobResult } from './result.ts';
import type { MdxIssueCode } from './types.ts';
import {
  maxBodyBytes,
  maxMergeBodyBytes,
  maxPrintBodyBytes,
  maxTreeBytes,
  ORGANIZATION_HEADER,
  wireMergeSchema,
  wirePrintSchema,
  wireRequestSchema,
} from './wire.ts';

export interface ParseHostOptions {
  readonly config: ParsePoolConfig;
  readonly port: number;
  readonly logger: ParseLogger;
  readonly maxHeldBytes?: number;
  readonly startThread?: () => ParseThread;
}

export interface ParseHost {
  readonly pool: ParsePool;
  readonly server: Server;
}

const MAX_PARSE_BODY = maxBodyBytes(DEFAULT_LIMITS.maxBytes);
const MAX_PRINT_BODY = maxPrintBodyBytes(maxTreeBytes(DEFAULT_LIMITS.maxBytes));
const MAX_MERGE_BODY = maxMergeBodyBytes(DEFAULT_LIMITS.maxBytes);
const BUSY_BODY = Symbol('busy');
const ROUTES = new Set(['/parse', '/print', '/merge']);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 256;

const BUSY: ReadonlySet<MdxIssueCode> = new Set([
  'mdx.queue_full',
  'mdx.organization_limit',
  'mdx.project_limit',
]);

const statusOf = (result: JobResult) =>
  !result.ok && result.error[0] !== undefined && BUSY.has(result.error[0].code) ? 429 : 200;

const empty = (response: ServerResponse, status: number) => {
  response.writeHead(status).end();
};

function readBody(
  request: IncomingMessage,
  cap: number,
  claim: HeldClaim,
): Promise<string | undefined | typeof BUSY_BODY> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > cap) {
        resolve(undefined);
        request.destroy();
      } else if (claim.take(chunk.byteLength)) chunks.push(chunk);
      else {
        request.removeAllListeners('data');
        request.pause();
        resolve(BUSY_BODY);
      }
    });
    request.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.once('error', () => {
      resolve(undefined);
    });
  });
}

// Refused unread where it can be, so the connection goes too: the rest of the body is not wanted.
function refuseBusy(request: IncomingMessage, response: ServerResponse) {
  response
    .writeHead(429, { 'content-type': 'application/json', connection: 'close' })
    .end(JSON.stringify(refused('mdx.queue_full')), () => {
      request.destroy();
    });
}

function jobFor(
  pool: ParsePool,
  url: string,
  body: string,
  organization: string,
): Promise<JobResult> {
  const json: unknown = JSON.parse(body);
  const checked = <T extends { tenant: { organizationId: string } }>(frame: T): T => {
    if (frame.tenant.organizationId !== organization) throw new Error('not the same organization');
    return frame;
  };
  if (url === '/merge') {
    const frame = checked(wireMergeSchema.parse(json));
    return pool.merge({
      ...frame,
      tenant: frame.tenant as TenantRef,
      policy: { ...frame.policy, components: new Set(frame.policy.components) },
    });
  }
  if (url === '/print') {
    const frame = checked(wirePrintSchema.parse(json));
    return pool.print({
      ...frame,
      tenant: frame.tenant as TenantRef,
      policy: { ...frame.policy, components: new Set(frame.policy.components) },
    });
  }
  const frame = checked(wireRequestSchema.parse(json));
  return pool.parse({
    ...frame,
    tenant: frame.tenant as TenantRef,
    policy: { ...frame.policy, components: new Set(frame.policy.components) },
  });
}

const capOf = (url: string) => {
  if (url === '/merge') return MAX_MERGE_BODY;
  return url === '/print' ? MAX_PRINT_BODY : MAX_PARSE_BODY;
};

async function serveClaimed(
  pool: ParsePool,
  request: IncomingMessage,
  response: ServerResponse,
  organization: string,
  claim: HeldClaim,
) {
  const url = request.url ?? '';
  const cap = capOf(url);
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > cap) {
    empty(response, 413);
    request.destroy();
    return;
  }
  if (!claim.fits(declared)) {
    refuseBusy(request, response);
    return;
  }
  const body = await readBody(request, cap, claim);
  if (body === BUSY_BODY) {
    refuseBusy(request, response);
    return;
  }
  if (body === undefined) {
    empty(response, 413);
    return;
  }
  try {
    const result = await jobFor(pool, url, body, organization);
    response
      .writeHead(statusOf(result), { 'content-type': 'application/json' })
      .end(JSON.stringify(result));
  } catch {
    // Only a frame that fails its checks gets here. Nothing of it goes back or into a log.
    empty(response, 400);
  }
}

async function serve(
  pool: ParsePool,
  held: HeldBytes,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const { url = '', method } = request;
  if (url === '/health') {
    empty(response, 200);
    return;
  }
  if (method !== 'POST' || !ROUTES.has(url)) {
    empty(response, 404);
    return;
  }
  const organization = request.headers[ORGANIZATION_HEADER];
  if (typeof organization !== 'string' || organization === '') {
    empty(response, 400);
    return;
  }
  const claim = held.claim(organization);
  try {
    await serveClaimed(pool, request, response, organization, claim);
  } finally {
    claim.release();
  }
}

// The boundary is this process: started with --permission and an env allow list, on a network
// the platform closes. A thread inside it is only the per page kill.
export async function startParseHost(options: ParseHostOptions): Promise<ParseHost> {
  const { config, logger } = options;
  const held = createHeldBytes(options.maxHeldBytes ?? DEFAULT_MAX_HELD_BYTES);
  const pool = createParsePool(config, {
    logger,
    // terminate has no bound on native work. SIGKILL does, and the supervisor restarts us.
    // Pages in flight lose their connection, which callers read as try again.
    onStuck: () => {
      process.kill(process.pid, 'SIGKILL');
    },
    ...(options.startThread && { startThread: options.startThread }),
  });
  const server = createServer((request, response) => {
    void serve(pool, held, request, response);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.maxConnections = MAX_CONNECTIONS;
  await new Promise<void>((resolve) => {
    server.listen(options.port, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  process.stdout.write(`${JSON.stringify({ event: 'mdx.parse_host_listening', port })}\n`);
  return { pool, server };
}
