import { PassThrough } from 'node:stream';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { createMcpServer, serveStdio } from '../src/index.ts';
import { TENANT, VERSIONS, fakeRetrieval } from './support/fake.ts';

// Reads newline delimited JSON-RPC messages from the server's stdout.
function lines(stream: PassThrough) {
  const seen: unknown[] = [];
  let buffer = '';
  const waiters: (() => void)[] = [];
  stream.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf('\n');
    while (at >= 0) {
      seen.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
      at = buffer.indexOf('\n');
    }
    for (const wake of waiters.splice(0)) wake();
  });
  return async (count: number): Promise<unknown[]> => {
    while (seen.length < count) await new Promise<void>((wake) => waiters.push(wake));
    return seen.slice(0, count);
  };
}

describe('stdio', () => {
  it('serves the same tools over newline delimited JSON-RPC', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const read = lines(stdout);
    const { retrieval, calls } = fakeRetrieval();
    const served = await serveStdio(createMcpServer({ retrieval, tenant: TENANT }), {
      stdin,
      stdout,
    });
    const send = (message: unknown) => stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 't', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_versions' } });
    const [, listed, called] = (await read(3)) as [
      unknown,
      { result: { tools: { name: string }[] } },
      { result: { structuredContent: unknown } },
    ];
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      'search_docs',
      'get_page',
      'list_versions',
    ]);
    expect(called.result.structuredContent).toEqual(VERSIONS);
    expect(calls).toEqual([{ op: 'listVersions', tenant: TENANT }]);
    await served.close();
  });
});
