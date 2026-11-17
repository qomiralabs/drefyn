import type { Retrieval, RetrievalErrorCode, RetrievalResult } from '@drefyn/retrieval';
import type { TenantRef } from '@drefyn/tenancy';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

// The library is the only source of answers. The scored search is left out by type, since
// scores are for the reader assistant's gate and never leave the service.
export type McpRetrieval = Pick<Retrieval, 'retrieve' | 'getPage' | 'listVersions'>;

export const MCP_TOOLS = Object.freeze(['search_docs', 'get_page', 'list_versions'] as const);
export type McpToolName = (typeof MCP_TOOLS)[number];

// The same rules the library applies, so the schema a client sees is the one that is enforced,
// and the adapter refuses exactly what the library refuses. The parity property holds them to
// that.
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STARTS_WITH_SLASH = new RegExp('^/');

const codePoints = (value: string) => Array.from(value).length;

const version = z
  .string()
  .min(1)
  .max(100)
  .describe("A docs version label. Defaults to 'latest'; list_versions names the others.");

const searchInput = z.strictObject({
  query: z
    .string()
    .refine((value) => {
      const length = codePoints(value.normalize('NFC').trim());
      return length >= 1 && length <= 512;
    })
    .describe('What to look for, 1 to 512 characters. Any word matches, ranked by relevance.'),
  version: version.optional(),
  limit: z.number().int().min(1).max(20).describe('Hits to return, 1 to 20. Default 8.').optional(),
  pathPrefix: z
    .string()
    .regex(STARTS_WITH_SLASH)
    .max(256)
    .describe("Only pages at this path or under it, such as '/guides'.")
    .optional(),
});

const pageInput = z.strictObject({
  path: z
    .string()
    .regex(STARTS_WITH_SLASH)
    .max(2048)
    .describe("The page path, such as '/guides/install'. Give this or nodeId, not both.")
    .optional(),
  nodeId: z
    .string()
    .regex(CANONICAL_UUID)
    .describe('The page id from a search hit. Give this or path, not both.')
    .optional(),
  version: version.optional(),
});

const noInput = z.strictObject({});

const pin = z.object({ version: z.string(), publishedAt: z.string() });
const headingPath = z.array(z.string());

const searchOutput = z.object({
  pin,
  ranking: z.enum(['lexical', 'hybrid']),
  hits: z.array(
    z.object({
      chunkId: z.string(),
      nodeId: z.string(),
      versionId: z.string(),
      path: z.string(),
      title: z.string(),
      headingPath,
      text: z.string(),
      rank: z.number().int(),
    }),
  ),
});

const pageOutput = z.object({
  pin,
  nodeId: z.string(),
  versionId: z.string(),
  path: z.string(),
  title: z.string(),
  sections: z.array(z.object({ headingPath, text: z.string() })),
});

const versionsOutput = z.object({
  versions: z.array(
    z.object({ label: z.string(), isDefault: z.boolean(), deprecated: z.boolean() }),
  ),
});

// Keyed by the library's code type, so a code added there fails typecheck here until listed.
const CODES: Readonly<Record<RetrievalErrorCode, true>> = {
  'retrieval.bad_input': true,
  'retrieval.version_not_found': true,
  'retrieval.not_found': true,
  'retrieval.busy': true,
  'retrieval.unavailable': true,
};
const ERROR_CODES = Object.keys(CODES) as [RetrievalErrorCode, ...RetrievalErrorCode[]];

// A refusal is structured content too, and the official client checks any structured content
// against the output schema, error or not. So each output is the library's value or this.
const refusal = z.strictObject({ code: z.enum(ERROR_CODES) });

type Outcome = RetrievalResult<object>;

interface ToolSpec {
  readonly description: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly run: (retrieval: McpRetrieval, tenant: TenantRef, args: unknown) => Promise<Outcome>;
}

const BAD_INPUT: Outcome = { ok: false, error: 'retrieval.bad_input' };

// An absent argument stays absent, so the library applies its own default.
const present = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const SPECS: Readonly<Record<McpToolName, ToolSpec>> = {
  search_docs: {
    description:
      "Search this project's published docs. Matches any word, ranked by relevance. Returns " +
      'passages with their page path, title and heading path, pinned to the version read.',
    input: searchInput,
    output: z.union([searchOutput, refusal]),
    run: async (retrieval, tenant, args) => {
      const parsed = searchInput.safeParse(args);
      if (!parsed.success) return BAD_INPUT;
      const { query, version: label, limit, pathPrefix } = parsed.data;
      return retrieval.retrieve(tenant, {
        query,
        ...present('version', label),
        ...present('limit', limit),
        ...present('pathPrefix', pathPrefix),
      });
    },
  },
  get_page: {
    description:
      'Read one published docs page by its path or its node id, section by section, pinned to ' +
      'the version read. Protected and unpublished pages are not found.',
    input: pageInput,
    output: z.union([pageOutput, refusal]),
    run: async (retrieval, tenant, args) => {
      const parsed = pageInput.safeParse(args);
      if (!parsed.success) return BAD_INPUT;
      const { path, nodeId, version: label } = parsed.data;
      if ((path === undefined) === (nodeId === undefined)) return BAD_INPUT;
      return retrieval.getPage(tenant, {
        ...present('path', path),
        ...present('nodeId', nodeId),
        ...present('version', label),
      });
    },
  },
  list_versions: {
    description: "List this project's docs versions and say which one is the default.",
    input: noInput,
    output: z.union([versionsOutput, refusal]),
    run: async (retrieval, tenant, args) =>
      noInput.safeParse(args).success ? retrieval.listVersions(tenant) : BAD_INPUT,
  },
};

// Every tool schema is an object; the dialect line is dropped, since MCP fixes the dialect.
const jsonSchema = (schema: z.ZodType, io: 'input' | 'output'): Tool['inputSchema'] => {
  const json: Record<string, unknown> = { ...z.toJSONSchema(schema, { io }) };
  delete json['$schema'];
  return { ...json, type: 'object' };
};

const READ_ONLY = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

// Built once: the same list for every request and every server.
export const TOOL_LIST: readonly Tool[] = Object.freeze(
  MCP_TOOLS.map((name): Tool => ({
    name,
    description: SPECS[name].description,
    inputSchema: jsonSchema(SPECS[name].input, 'input'),
    outputSchema: jsonSchema(SPECS[name].output, 'output'),
    annotations: READ_ONLY,
  })),
);

export const isToolName = (name: string): name is McpToolName =>
  (MCP_TOOLS as readonly string[]).includes(name);

export const runTool = (
  name: McpToolName,
  retrieval: McpRetrieval,
  tenant: TenantRef,
  args: unknown,
): Promise<Outcome> => SPECS[name].run(retrieval, tenant, args);
