import type { RetrievalResult } from '@drefyn/retrieval';
import type { TenantRef } from '@drefyn/tenancy';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { isToolName, runTool, TOOL_LIST, type McpRetrieval } from './tools.ts';

export type McpLogFields = Readonly<Record<string, string | number | boolean>>;

// Ids, the tool, the outcome and the time. Never arguments or results: they hold the question
// and page text.
export interface McpLogger {
  info(event: string, fields: McpLogFields): void;
  warn(event: string, fields: McpLogFields): void;
}

export interface McpServerDeps {
  readonly retrieval: McpRetrieval;
  // Proved by whoever built this server, from a key or the stdio settings. No tool argument
  // can name another one: every input schema is strict and has no tenant field.
  readonly tenant: TenantRef;
  readonly logger?: McpLogger;
}

export const MCP_SERVER_INFO = Object.freeze({ name: 'drefyn-docs', version: '1.0.0' });

const INSTRUCTIONS =
  "Read this project's published docs. search_docs finds passages, get_page reads a whole " +
  'page by the path or node id a hit gives, list_versions names the versions to pin to.';

const noopLogger: McpLogger = { info: () => undefined, warn: () => undefined };

// Structured content is the library's value as it is, and the text block is the same value as
// JSON, so a client that reads either sees exactly what the library said.
function resultOf(outcome: RetrievalResult<object>): CallToolResult {
  if (outcome.ok) {
    const value = { ...outcome.value };
    return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
  const body = { code: outcome.error };
  return {
    isError: true,
    structuredContent: body,
    content: [{ type: 'text', text: JSON.stringify(body) }],
  };
}

// One server per request over HTTP, or one per process over stdio. It holds no state between
// calls, so any instance can answer any request. The tool handlers sit on the protocol server
// underneath, not on registerTool, because registerTool answers a schema failure with free
// text; here every refusal carries the library's code.
export function createMcpServer(deps: McpServerDeps): McpServer {
  const { retrieval, tenant } = deps;
  const logger = deps.logger ?? noopLogger;
  const ids = { organizationId: tenant.organizationId, projectId: tenant.projectId };
  const mcp = new McpServer(MCP_SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
    instructions: INSTRUCTIONS,
  });
  const server = mcp.server;

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOL_LIST] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = request.params.name;
    // The name is not echoed: it came from the client.
    if (!isToolName(tool)) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
    const started = performance.now();
    let outcome: RetrievalResult<object>;
    try {
      outcome = await runTool(tool, retrieval, tenant, request.params.arguments ?? {});
    } catch (error) {
      // The library answers failures as values; a throw is a bug, and its message may hold
      // whatever it was carrying, so only the kind is kept.
      logger.warn('mcp.tool_failed', {
        ...ids,
        tool,
        error: error instanceof Error ? error.name : typeof error,
      });
      outcome = { ok: false, error: 'retrieval.unavailable' };
    }
    logger.info('mcp.tool_call', {
      ...ids,
      tool,
      outcome: outcome.ok ? 'ok' : outcome.error,
      ms: Math.round((performance.now() - started) * 10) / 10,
    });
    return resultOf(outcome);
  });

  return mcp;
}
