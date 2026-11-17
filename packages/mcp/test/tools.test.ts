import type { RetrievalErrorCode } from '@drefyn/retrieval';
import { organizationId, projectId } from '@drefyn/tenancy';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '../src/index.ts';
import {
  NODE,
  PAGE_RESULT,
  SEARCH_RESULT,
  TENANT,
  VERSIONS,
  connect,
  fakeRetrieval,
  memoryLogger,
  refusal,
} from './support/fake.ts';

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function open(...args: Parameters<typeof connect>) {
  const opened = await connect(...args);
  close = opened.close;
  return opened.client;
}

interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

const call = async (
  client: Awaited<ReturnType<typeof open>>,
  name: string,
  args?: Record<string, unknown>,
) =>
  (await client.callTool({
    name,
    ...(args === undefined ? {} : { arguments: args }),
  })) as ToolResult;

const CODES: readonly RetrievalErrorCode[] = [
  'retrieval.bad_input',
  'retrieval.version_not_found',
  'retrieval.not_found',
  'retrieval.busy',
  'retrieval.unavailable',
];

describe('tool list', () => {
  it('names the three tools, in a fixed order', async () => {
    const client = await open(fakeRetrieval().retrieval);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...MCP_TOOLS]);
    expect(MCP_TOOLS).toEqual(['search_docs', 'get_page', 'list_versions']);
    expect(Object.isFrozen(MCP_TOOLS)).toBe(true);
  });

  it('marks every tool read only, idempotent and closed world, with both schemas', async () => {
    const client = await open(fakeRetrieval().retrieval);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(20);
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.outputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('describes search_docs input with the library limits', async () => {
    const client = await open(fakeRetrieval().retrieval);
    const { tools } = await client.listTools();
    const search = tools.find((tool) => tool.name === 'search_docs');
    expect(search?.inputSchema.required).toEqual(['query']);
    expect(search?.inputSchema.properties).toMatchObject({
      query: { type: 'string' },
      version: { type: 'string', minLength: 1, maxLength: 100 },
      limit: { type: 'integer', minimum: 1, maximum: 20 },
      pathPrefix: { type: 'string', maxLength: 256, pattern: '^/' },
    });
    expect(search?.description).toContain('any word, ranked by relevance');
    expect(search?.outputSchema?.required).toEqual(['pin', 'ranking', 'hits']);
  });

  it('describes get_page and list_versions input', async () => {
    const client = await open(fakeRetrieval().retrieval);
    const { tools } = await client.listTools();
    const page = tools.find((tool) => tool.name === 'get_page');
    expect(page?.inputSchema.required ?? []).toEqual([]);
    expect(Object.keys(page?.inputSchema.properties ?? {}).sort()).toEqual([
      'nodeId',
      'path',
      'version',
    ]);
    expect(page?.outputSchema?.required).toEqual([
      'pin',
      'nodeId',
      'versionId',
      'path',
      'title',
      'sections',
    ]);
    const versions = tools.find((tool) => tool.name === 'list_versions');
    expect(versions?.inputSchema.properties ?? {}).toEqual({});
    expect(versions?.outputSchema?.required).toEqual(['versions']);
  });

  it('never offers a field for the tenant', async () => {
    const client = await open(fakeRetrieval().retrieval);
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const names = Object.keys(tool.inputSchema.properties ?? {});
      expect(names.some((name) => /organization|project|tenant/i.test(name))).toBe(false);
    }
  });
});

describe('tool results', () => {
  it('search_docs returns the library result as structured content and one text block', async () => {
    const { retrieval, calls } = fakeRetrieval();
    const client = await open(retrieval);
    const result = await call(client, 'search_docs', { query: 'install', limit: 3 });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toEqual(SEARCH_RESULT);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(SEARCH_RESULT) }]);
    expect(calls).toEqual([
      { op: 'retrieve', tenant: TENANT, input: { query: 'install', limit: 3 } },
    ]);
  });

  it('get_page passes path or node id and returns the page', async () => {
    const { retrieval, calls } = fakeRetrieval();
    const client = await open(retrieval);
    const byPath = await call(client, 'get_page', { path: '/guides/install' });
    const byNode = await call(client, 'get_page', { nodeId: NODE, version: 'latest' });
    expect(byPath.structuredContent).toEqual(PAGE_RESULT);
    expect(byNode.content).toEqual([{ type: 'text', text: JSON.stringify(PAGE_RESULT) }]);
    expect(calls.map((c) => c.input)).toEqual([
      { path: '/guides/install' },
      { nodeId: NODE, version: 'latest' },
    ]);
  });

  it('list_versions takes no arguments, with or without an empty object', async () => {
    const { retrieval, calls } = fakeRetrieval();
    const client = await open(retrieval);
    expect((await call(client, 'list_versions')).structuredContent).toEqual(VERSIONS);
    expect((await call(client, 'list_versions', {})).structuredContent).toEqual(VERSIONS);
    expect(calls).toEqual([
      { op: 'listVersions', tenant: TENANT },
      { op: 'listVersions', tenant: TENANT },
    ]);
  });

  it.each(CODES)('maps the library error %s to a tool error with the code', async (code) => {
    const client = await open(
      fakeRetrieval({
        retrieve: () => refusal(code),
        getPage: () => refusal(code),
        listVersions: () => refusal(code),
      }).retrieval,
    );
    for (const [name, args] of [
      ['search_docs', { query: 'install' }],
      ['get_page', { path: '/x' }],
      ['list_versions', {}],
    ] as const) {
      const result = await call(client, name, args);
      expect(result).toEqual({
        isError: true,
        structuredContent: { code },
        content: [{ type: 'text', text: JSON.stringify({ code }) }],
      });
    }
  });

  it('answers unavailable when the library throws, and says nothing of the failure', async () => {
    const { logger, lines } = memoryLogger();
    const client = await open(
      fakeRetrieval({ retrieve: () => Promise.reject(new Error('secret connection detail')) })
        .retrieval,
      { logger },
    );
    const result = await call(client, 'search_docs', { query: 'install' });
    expect(result.structuredContent).toEqual({ code: 'retrieval.unavailable' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(lines)).not.toContain('secret');
    expect(lines.some((line) => line.level === 'warn' && line.event === 'mcp.tool_failed')).toBe(
      true,
    );
  });

  it('keeps the tenant it was built with, whatever the arguments carry', async () => {
    const { retrieval, calls } = fakeRetrieval();
    const client = await open(retrieval);
    const other = {
      organizationId: organizationId('01a14984-4476-77ce-9335-2c3c3a59aaff'),
      projectId: projectId('01a14984-4476-77ce-9335-2c3c3a59aafe'),
    };
    const result = await call(client, 'search_docs', { query: 'install', ...other });
    expect(result.structuredContent).toEqual({ code: 'retrieval.bad_input' });
    await call(client, 'search_docs', { query: 'install' });
    expect(calls.map((c) => c.tenant)).toEqual([TENANT]);
  });

  it('refuses an unknown tool as a protocol error', async () => {
    const client = await open(fakeRetrieval().retrieval);
    await expect(call(client, 'get_style_guide', {})).rejects.toBeInstanceOf(McpError);
  });
});

describe('input validation', () => {
  const badSearch: readonly Record<string, unknown>[] = [
    {},
    { query: '' },
    { query: '   ' },
    { query: 'x'.repeat(513) },
    { query: 7 },
    { query: 'a', limit: 0 },
    { query: 'a', limit: 21 },
    { query: 'a', limit: 1.5 },
    { query: 'a', limit: '3' },
    { query: 'a', version: '' },
    { query: 'a', version: 'v'.repeat(101) },
    { query: 'a', pathPrefix: 'guides' },
    { query: 'a', pathPrefix: `/${'p'.repeat(256)}` },
    { query: 'a', extra: true },
  ];

  it.each(badSearch)('search_docs refuses %j before the library is called', async (args) => {
    const { retrieval, calls } = fakeRetrieval();
    const client = await open(retrieval);
    const result = await call(client, 'search_docs', args);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ code: 'retrieval.bad_input' });
    expect(calls).toEqual([]);
  });

  const badPage: readonly Record<string, unknown>[] = [
    {},
    { path: '/a', nodeId: NODE },
    { path: 'a' },
    { path: `/${'p'.repeat(2048)}` },
    { nodeId: 'not-a-uuid' },
    { nodeId: NODE.toUpperCase() },
    { path: '/a', version: '' },
    { path: '/a', extra: 1 },
  ];

  it.each(badPage)('get_page refuses %j before the library is called', async (args) => {
    const { retrieval, calls } = fakeRetrieval();
    const client = await open(retrieval);
    const result = await call(client, 'get_page', args);
    expect(result.structuredContent).toEqual({ code: 'retrieval.bad_input' });
    expect(calls).toEqual([]);
  });

  it('list_versions refuses any argument', async () => {
    const { retrieval, calls } = fakeRetrieval();
    const client = await open(retrieval);
    const result = await call(client, 'list_versions', { version: 'latest' });
    expect(result.structuredContent).toEqual({ code: 'retrieval.bad_input' });
    expect(calls).toEqual([]);
  });

  it('never echoes the refused input', async () => {
    const client = await open(fakeRetrieval().retrieval);
    const result = await call(client, 'search_docs', { query: 'canary-7f3a', limit: 99 });
    expect(JSON.stringify(result)).not.toContain('canary-7f3a');
  });
});

describe('logs', () => {
  it('write one line per call with ids, tool, outcome and time, never the question or text', async () => {
    const { logger, lines } = memoryLogger();
    const client = await open(
      fakeRetrieval({
        getPage: () => refusal('retrieval.not_found'),
      }).retrieval,
      { logger },
    );
    await call(client, 'search_docs', { query: 'question-canary-91' });
    await call(client, 'get_page', { path: '/path-canary-92' });
    await call(client, 'list_versions');
    await call(client, 'search_docs', { query: 'question-canary-93', limit: 0 });
    const calls = lines.filter((line) => line.event === 'mcp.tool_call');
    expect(calls.map((line) => [line.fields['tool'], line.fields['outcome']])).toEqual([
      ['search_docs', 'ok'],
      ['get_page', 'retrieval.not_found'],
      ['list_versions', 'ok'],
      ['search_docs', 'retrieval.bad_input'],
    ]);
    for (const line of calls) {
      expect(Object.keys(line.fields).sort()).toEqual([
        'ms',
        'organizationId',
        'outcome',
        'projectId',
        'tool',
      ]);
      expect(line.fields['organizationId']).toBe(TENANT.organizationId);
      expect(line.fields['projectId']).toBe(TENANT.projectId);
    }
    const all = JSON.stringify(lines);
    for (const canary of ['question-canary', 'path-canary', 'Run pnpm add', 'Intro text']) {
      expect(all).not.toContain(canary);
    }
  });

  it('are optional', async () => {
    const client = await open(fakeRetrieval().retrieval);
    const result = await call(client, 'list_versions');
    expect(result.structuredContent).toEqual(VERSIONS);
  });
});
