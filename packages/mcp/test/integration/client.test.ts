import { join } from 'node:path';
import type { Retrieval } from '@drefyn/retrieval';
import type { TenantRef } from '@drefyn/tenancy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { beforeAll, expect, it } from 'vitest';
import { createMcpServer, handleMcpHttp, MCP_TOOLS } from '../../src/index.ts';
import {
  describeWithStack,
  pools,
  readerEnv,
  retrievalOver,
  seedPages,
  seedTenants,
  type SeededPage,
} from '../support/fixture.ts';

const open = pools();
let retrieval: Retrieval;
let tenant: TenantRef;
let pages: SeededPage[];

// The stock client's own Streamable HTTP transport, with its fetch answered by the package
// handler: real requests and responses, one MCP server per request as the API runs it.
const answer = (input: string | URL | Request, init?: RequestInit) =>
  handleMcpHttp(new Request(input, init), createMcpServer({ retrieval, tenant }), {
    maxBodyBytes: 65_536,
  });

describeWithStack('a stock MCP client lists and calls every tool', () => {
  beforeAll(async () => {
    const { app, reader } = await open();
    retrieval = retrievalOver(reader);
    const [seeded] = await seedTenants([1]);
    if (seeded === undefined) throw new Error('seed failed');
    tenant = seeded.tenant;
    pages = await seedPages(app, seeded, [
      { slug: 'install', versions: [{ state: 'current', body: 'Install the cli with pnpm.' }] },
      { slug: 'deploy', versions: [{ state: 'current', body: 'Deploy with the cli and pnpm.' }] },
    ]);
  });

  // Every call goes through the client's own output schema check as well as ours.
  async function exercise(transport: Transport) {
    const client = new Client({ name: 'stock', version: '0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOLS]);

    const search = await client.callTool({ name: 'search_docs', arguments: { query: 'pnpm cli' } });
    const direct = await retrieval.retrieve(tenant, { query: 'pnpm cli' });
    expect(direct.ok).toBe(true);
    if (direct.ok) {
      expect(search.structuredContent).toEqual(direct.value);
      expect(direct.value.hits.map((hit) => hit.path).sort()).toEqual(['/deploy', '/install']);
    }

    const install = pages[0];
    if (install === undefined) throw new Error('seed failed');
    const page = await client.callTool({ name: 'get_page', arguments: { nodeId: install.nodeId } });
    const directPage = await retrieval.getPage(tenant, { nodeId: install.nodeId });
    expect(directPage.ok).toBe(true);
    if (directPage.ok) expect(page.structuredContent).toEqual(directPage.value);

    const versions = await client.callTool({ name: 'list_versions', arguments: {} });
    const directVersions = await retrieval.listVersions(tenant);
    if (directVersions.ok) expect(versions.structuredContent).toEqual(directVersions.value);

    const missing = await client.callTool({ name: 'get_page', arguments: { path: '/nope' } });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toEqual({ code: 'retrieval.not_found' });
    await client.close();
  }

  it('over Streamable HTTP, stateless, with JSON answers', async () => {
    await exercise(
      new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), { fetch: answer }),
    );
  });

  it('over stdio', async () => {
    await exercise(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(import.meta.dirname, '..', 'support', 'stdio-server.ts')],
        env: {
          PATH: process.env['PATH'] ?? '',
          ...readerEnv(),
          MCP_TEST_ORGANIZATION_ID: tenant.organizationId,
          MCP_TEST_PROJECT_ID: tenant.projectId,
        },
        stderr: 'pipe',
      }),
    );
  });
});
