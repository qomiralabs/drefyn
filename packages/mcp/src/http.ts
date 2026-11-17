import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

export interface McpHttpOptions {
  // Bytes. The SDK reads no more than this before answering 413.
  readonly maxBodyBytes: number;
}

// Stateless: there is no session to resume or stream to hold open, so GET and DELETE have
// nothing to act on.
function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }),
    {
      status: 405,
      headers: { allow: 'POST', 'content-type': 'application/json' },
    },
  );
}

// Answers one Streamable HTTP request with JSON and closes the server after it, so nothing
// outlives the request. The caller builds the server for the tenant it proved.
export async function handleMcpHttp(
  request: Request,
  server: McpServer,
  options: McpHttpOptions,
): Promise<Response> {
  if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1) {
    throw new RangeError('maxBodyBytes must be a positive whole number');
  }
  if (request.method !== 'POST') {
    await server.close();
    return methodNotAllowed();
  }
  // No session id generator is what makes the transport stateless.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize: options.maxBodyBytes,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
