import type { Readable, Writable } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export interface StdioStreams {
  readonly stdin: Readable;
  readonly stdout: Writable;
}

export interface ServedStdio {
  close(): Promise<void>;
}

// The same server over newline delimited JSON-RPC, for clients that start a local process.
// Logs must go to stderr: stdout carries the protocol.
export async function serveStdio(server: McpServer, streams?: StdioStreams): Promise<ServedStdio> {
  const transport =
    streams === undefined
      ? new StdioServerTransport()
      : new StdioServerTransport(streams.stdin, streams.stdout);
  await server.connect(transport);
  return { close: () => server.close() };
}
