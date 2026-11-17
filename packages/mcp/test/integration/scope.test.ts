import type { PublishedDatabase } from '@drefyn/db';
import type { Retrieval } from '@drefyn/retrieval';
import type { TenantRef } from '@drefyn/tenancy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, expect, it } from 'vitest';
import { createMcpServer } from '../../src/index.ts';
import {
  describeWithStack,
  pools,
  retrievalOver,
  seedPages,
  seedTenants,
  type SeededPage,
} from '../support/fixture.ts';

// One word each, so a search for it finds exactly the page that holds it, wherever that is.
const OWN = 'zephyrownpage';
const SIBLING = 'quokkasiblingproject';
const FOREIGN = 'narwhalforeignorganization';
const PROTECTED = 'axolotlprotectedpage';
const DRAFT = 'pangolindraftonly';
const OLD = 'ocelotreplacedversion';
const LEAKS = [SIBLING, FOREIGN, PROTECTED, DRAFT, OLD] as const;

const open = pools();
let reader: PublishedDatabase;
let retrieval: Retrieval;
let own: TenantRef;
let ownPages: SeededPage[];
let siblingPages: SeededPage[];
let foreignPages: SeededPage[];

interface ToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
  readonly content: readonly { readonly text?: string }[];
}

// A server for one project, as the API builds one for each request from the key's project.
async function clientFor(tenant: TenantRef) {
  const server = createMcpServer({ retrieval, tenant });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scope', version: '0' });
  await server.connect(b);
  await client.connect(a);
  return {
    call: async (name: string, args: Record<string, unknown>) =>
      (await client.callTool({ name, arguments: args })) as ToolResult,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describeWithStack('an MCP server reads its own project only', () => {
  beforeAll(async () => {
    const { app, reader: opened } = await open();
    reader = opened;
    retrieval = retrievalOver(reader);
    const [a1, a2, b1] = await seedTenants([2, 1]);
    if (a1 === undefined || a2 === undefined || b1 === undefined) throw new Error('seed failed');
    own = a1.tenant;
    ownPages = await seedPages(app, a1, [
      { slug: 'own', versions: [{ state: 'current', body: `The ${OWN} guide.` }] },
      {
        slug: 'secret',
        versions: [{ state: 'current', visibility: 'protected', body: `Hidden ${PROTECTED}.` }],
      },
      {
        slug: 'unpublished',
        versions: [
          { state: 'current', body: 'Published text.' },
          { state: 'draft', body: `Draft ${DRAFT}.` },
        ],
      },
      {
        slug: 'changed',
        versions: [
          { state: 'old', body: `Old ${OLD}.` },
          { state: 'current', body: 'New text.' },
        ],
      },
      { slug: 'draft-only', versions: [{ state: 'draft', body: `Never ${DRAFT} published.` }] },
    ]);
    siblingPages = await seedPages(app, a2, [
      { slug: 'own', versions: [{ state: 'current', body: `Sibling ${SIBLING}.` }] },
    ]);
    foreignPages = await seedPages(app, b1, [
      { slug: 'own', versions: [{ state: 'current', body: `Foreign ${FOREIGN}.` }] },
    ]);
  });

  it('finds its own public page', async () => {
    const client = await clientFor(own);
    const result = await client.call('search_docs', { query: OWN });
    const hits = (result.structuredContent?.['hits'] ?? []) as { path: string }[];
    expect(hits.map((hit) => hit.path)).toEqual(['/own']);
    await client.close();
  });

  it.each(LEAKS)('never returns %s from search_docs', async (word) => {
    const client = await clientFor(own);
    const result = await client.call('search_docs', { query: word });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.['hits']).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(word);
    await client.close();
  });

  it('cannot read another project or organization by path or node id', async () => {
    const client = await clientFor(own);
    const sibling = siblingPages[0];
    const foreign = foreignPages[0];
    if (sibling === undefined || foreign === undefined) throw new Error('seed failed');
    for (const args of [{ nodeId: sibling.nodeId }, { nodeId: foreign.nodeId }]) {
      const result = await client.call('get_page', args);
      expect(result.structuredContent).toEqual({ code: 'retrieval.not_found' });
    }
    // The same path exists in every project: the own one answers, with its own text.
    const byPath = await client.call('get_page', { path: '/own' });
    const text = JSON.stringify(byPath);
    expect(text).toContain(OWN);
    for (const word of LEAKS) expect(text).not.toContain(word);
    await client.close();
  });

  it('never serves a protected page, a draft or a replaced version', async () => {
    const client = await clientFor(own);
    const secret = ownPages.find((page) => page.path === '/secret');
    const draftOnly = ownPages.find((page) => page.path === '/draft-only');
    if (secret === undefined || draftOnly === undefined) throw new Error('seed failed');
    for (const args of [
      { path: '/secret' },
      { nodeId: secret.nodeId },
      { path: '/draft-only' },
      { nodeId: draftOnly.nodeId },
    ]) {
      const result = await client.call('get_page', args);
      expect(result.structuredContent).toEqual({ code: 'retrieval.not_found' });
    }
    for (const path of ['/unpublished', '/changed']) {
      const text = JSON.stringify(await client.call('get_page', { path }));
      for (const word of LEAKS) expect(text).not.toContain(word);
    }
    await client.close();
  });

  it('answers a question naming every tenant with its own page only', async () => {
    const client = await clientFor(own);
    const result = await client.call('search_docs', { query: `${OWN} ${SIBLING} ${FOREIGN}` });
    const hits = (result.structuredContent?.['hits'] ?? []) as { path: string; text: string }[];
    expect(hits.map((hit) => hit.text)).toEqual([`The ${OWN} guide.`]);
    await client.close();
  });

  it('answers not found for everything with the retrieval flag off', async () => {
    const off = createMcpServer({ retrieval: retrievalOver(reader, false), tenant: own });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'off', version: '0' });
    await off.connect(b);
    await client.connect(a);
    for (const [name, args] of [
      ['search_docs', { query: OWN }],
      ['get_page', { path: '/own' }],
      ['list_versions', {}],
    ] as const) {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      expect(result.structuredContent).toEqual({ code: 'retrieval.not_found' });
    }
    await client.close();
    await off.close();
  });
});
