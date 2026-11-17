import type {
  PageInput,
  PageResult,
  Retrieval,
  RetrievalErrorCode,
  RetrievalResult,
  RetrieveInput,
  RetrieveResult,
  VersionList,
} from '@drefyn/retrieval';
import { idOf, organizationId, projectId, type TenantRef } from '@drefyn/tenancy';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer, type McpLogger, type McpRetrieval } from '../../src/index.ts';

export const TENANT: TenantRef = {
  organizationId: organizationId('01a14984-4476-77ce-9335-2c3c3a59aa8b'),
  projectId: projectId('01a14984-4476-77ce-9335-2c3c3a59aa8c'),
};

export const NODE = '01a14984-4476-77ce-9335-2c3c3a59aa91';
export const VERSION = '01a14984-4476-77ce-9335-2c3c3a59aa92';

export const SEARCH_RESULT: RetrieveResult = {
  pin: { version: 'latest', publishedAt: '2026-11-17T09:00:00.000Z' },
  ranking: 'lexical',
  hits: [
    {
      chunkId: '01a14984-4476-77ce-9335-2c3c3a59aa93',
      nodeId: idOf('nod', NODE),
      versionId: idOf('ver', VERSION),
      path: '/guides/install',
      title: 'Install',
      headingPath: ['Install', 'With pnpm'],
      text: 'Run pnpm add drefyn.',
      rank: 1,
    },
  ],
};

export const PAGE_RESULT: PageResult = {
  pin: { version: 'latest', publishedAt: '2026-11-17T09:00:00.000Z' },
  nodeId: idOf('nod', NODE),
  versionId: idOf('ver', VERSION),
  path: '/guides/install',
  title: 'Install',
  sections: [
    { headingPath: [], text: 'Intro text.' },
    { headingPath: ['Install'], text: 'Run pnpm add drefyn.' },
  ],
};

export const VERSIONS: VersionList = {
  versions: [{ label: 'latest', isDefault: true, deprecated: false }],
};

export interface Call {
  readonly op: 'retrieve' | 'getPage' | 'listVersions';
  readonly tenant: TenantRef;
  readonly input?: unknown;
}

export interface FakeAnswers {
  retrieve?: (input: RetrieveInput) => Promise<RetrievalResult<RetrieveResult>>;
  getPage?: (input: PageInput) => Promise<RetrievalResult<PageResult>>;
  listVersions?: () => Promise<RetrievalResult<VersionList>>;
}

const ok = <T>(value: T): Promise<RetrievalResult<T>> => Promise.resolve({ ok: true, value });

export const refusal = <T>(error: RetrievalErrorCode): Promise<RetrievalResult<T>> =>
  Promise.resolve({ ok: false, error });

// A library that records every call and answers what the test says, or a fixed success.
export function fakeRetrieval(answers: FakeAnswers = {}) {
  const calls: Call[] = [];
  const retrieval: McpRetrieval = {
    retrieve: (tenant, input) => {
      calls.push({ op: 'retrieve', tenant, input });
      return answers.retrieve?.(input) ?? ok(SEARCH_RESULT);
    },
    getPage: (tenant, input) => {
      calls.push({ op: 'getPage', tenant, input });
      return answers.getPage?.(input) ?? ok(PAGE_RESULT);
    },
    listVersions: (tenant) => {
      calls.push({ op: 'listVersions', tenant });
      return answers.listVersions?.() ?? ok(VERSIONS);
    },
  };
  return { retrieval, calls };
}

export interface LogLine {
  readonly level: 'info' | 'warn';
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export function memoryLogger() {
  const lines: LogLine[] = [];
  const logger: McpLogger = {
    info: (event, fields) => lines.push({ level: 'info', event, fields }),
    warn: (event, fields) => lines.push({ level: 'warn', event, fields }),
  };
  return { logger, lines };
}

// The official client over an in memory pair, so tests see what any MCP client sees.
export async function connect(
  retrieval: McpRetrieval | Retrieval,
  options: { tenant?: TenantRef; logger?: McpLogger } = {},
) {
  const server = createMcpServer({
    retrieval,
    tenant: options.tenant ?? TENANT,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
  // The client keeps each tool's output schema from the list and checks every result against
  // it, as stock clients do.
  await client.listTools();
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
