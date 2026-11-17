import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { createMcpServer, handleMcpHttp } from '../src/index.ts';
import { SEARCH_RESULT, TENANT, fakeRetrieval } from './support/fake.ts';

const ACCEPT = 'application/json, text/event-stream';

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://mcp.test/mcp', {
    method: 'POST',
    headers: { accept: ACCEPT, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.0' },
  },
};

const searchCall = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'search_docs', arguments: { query: 'install' } },
};

function served(maxBodyBytes = 65_536) {
  const { retrieval, calls } = fakeRetrieval();
  const server = createMcpServer({ retrieval, tenant: TENANT });
  const closed = vi.fn();
  server.onclose = closed;
  return {
    calls,
    closed,
    handle: (request: Request) => handleMcpHttp(request, server, { maxBodyBytes }),
  };
}

describe('stateless Streamable HTTP', () => {
  it('answers initialize in JSON with no session id', async () => {
    const response = await served().handle(post(initialize));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe('drefyn-docs');
  });

  it('answers a tool call with no initialize before it, as any restarted server must', async () => {
    const { handle, calls } = served();
    const response = await handle(
      post(searchCall, { 'mcp-protocol-version': LATEST_PROTOCOL_VERSION }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { structuredContent: unknown } };
    expect(body.result.structuredContent).toEqual(SEARCH_RESULT);
    expect(calls).toHaveLength(1);
  });

  it('closes the server once the answer is written', async () => {
    const { handle, closed } = served();
    await handle(post(searchCall));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes the server when the request is refused early', async () => {
    const { handle, closed } = served();
    const response = await handle(post('{not json'));
    expect(response.status).toBe(400);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('accepts a notification with 202 and no body', async () => {
    const response = await served().handle(
      post({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it.each(['GET', 'DELETE', 'PUT'])('refuses %s with 405 and Allow: POST', async (method) => {
    const response = await served().handle(new Request('http://mcp.test/mcp', { method }));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32000);
  });

  it('refuses a body over the cap before parsing it', async () => {
    const { handle, calls } = served(256);
    const response = await handle(
      post({ ...searchCall, params: { ...searchCall.params, padding: 'x'.repeat(512) } }),
    );
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('refuses a request that is not JSON-RPC', async () => {
    const response = await served().handle(post({ hello: 'world' }));
    expect(response.status).toBe(400);
  });

  it('refuses a client that does not accept JSON', async () => {
    const response = await served().handle(post(searchCall, { accept: 'text/html' }));
    expect(response.status).toBe(406);
  });

  it('rejects a cap that is not a positive whole number', async () => {
    const { retrieval } = fakeRetrieval();
    const server = createMcpServer({ retrieval, tenant: TENANT });
    for (const maxBodyBytes of [0, -1, 1.5, Number.NaN]) {
      await expect(handleMcpHttp(post(initialize), server, { maxBodyBytes })).rejects.toThrow(
        RangeError,
      );
    }
  });
});
