import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { TenantRef } from '@drefyn/tenancy';
import { DEFAULT_LIMITS } from './policy.ts';
import { createParsePool } from './pool.ts';
import type { ParseLogger, ParsePool } from './pool.ts';
import type { ParsePoolConfig } from './pool-config.ts';
import type { ParseThread } from './thread.ts';
import type { MdxIssueCode, ParseResult } from './types.ts';
import { maxBodyBytes, wireRequestSchema } from './wire.ts';

export interface ParseHostOptions {
  readonly config: ParsePoolConfig;
  readonly port: number;
  readonly logger: ParseLogger;
  readonly startThread?: () => ParseThread;
}

export interface ParseHost {
  readonly pool: ParsePool;
  readonly server: Server;
}

const MAX_BODY_BYTES = maxBodyBytes(DEFAULT_LIMITS.maxBytes);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 256;

const BUSY: ReadonlySet<MdxIssueCode> = new Set([
  'mdx.queue_full',
  'mdx.organization_limit',
  'mdx.project_limit',
]);

const statusOf = (result: ParseResult) =>
  !result.ok && result.error[0] !== undefined && BUSY.has(result.error[0].code) ? 429 : 200;

const empty = (response: ServerResponse, status: number) => {
  response.writeHead(status).end();
};

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        resolve(undefined);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.once('error', () => {
      resolve(undefined);
    });
  });
}

async function serve(pool: ParsePool, request: IncomingMessage, response: ServerResponse) {
  if (request.url === '/health') {
    empty(response, 200);
    return;
  }
  if (request.method !== 'POST' || request.url !== '/parse') {
    empty(response, 404);
    return;
  }
  const body = await readBody(request);
  if (body === undefined) {
    empty(response, 413);
    return;
  }
  try {
    const frame = wireRequestSchema.parse(JSON.parse(body));
    const result = await pool.parse({
      ...frame,
      tenant: frame.tenant as TenantRef,
      policy: { ...frame.policy, components: new Set(frame.policy.components) },
    });
    response
      .writeHead(statusOf(result), { 'content-type': 'application/json' })
      .end(JSON.stringify(result));
  } catch {
    // Only a frame that fails its checks gets here. Nothing of it goes back or into a log.
    empty(response, 400);
  }
}

// The boundary is this process: started with --permission and an env allow list, on a network
// the platform closes. A thread inside it is only the per page kill.
export async function startParseHost(options: ParseHostOptions): Promise<ParseHost> {
  const { config, logger } = options;
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
    void serve(pool, request, response);
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
