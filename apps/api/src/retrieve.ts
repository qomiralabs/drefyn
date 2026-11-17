import type {
  Retrieval,
  RetrievalErrorCode,
  RetrieveInput,
  RetrieveResult,
} from '@drefyn/retrieval';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { ApiDeps, ApiEnv } from './app.ts';
import { ApiError } from './errors.ts';
import { guard, tenantOf } from './guard.ts';
import { planFeature } from './plan.ts';
import type { ApiScope } from './scopes.ts';

export const RETRIEVE_PATH = '/v1/projects/:projectId/retrieve';
export const RETRIEVE_SCOPE = 'docs:pages.read' satisfies ApiScope;

// The library checks the exact rules (512 characters after NFC and trimming). This cap only
// stops a huge string before anything normalizes it.
export const MAX_QUERY_LENGTH = 2048;
export const MAX_VERSION_LENGTH = 100;
export const MAX_LIMIT = 20;

const KNOWN: ReadonlySet<string> = new Set(['query', 'version', 'limit']);

// Plain digits only, no leading zero: Number() would also take ' 5', '1e1' and '0x5'.
const params = z.strictObject({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  version: z.string().min(1).max(MAX_VERSION_LENGTH).optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]?$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_LIMIT))
    .optional(),
});

// Null for anything refused, so the route answers one code and never echoes the input. A
// repeated or unknown parameter is refused rather than guessed at.
export function parseRetrieveQuery(search: URLSearchParams): RetrieveInput | null {
  const seen: Record<string, string> = {};
  for (const [name, value] of search) {
    if (!KNOWN.has(name) || Object.hasOwn(seen, name)) return null;
    seen[name] = value;
  }
  const parsed = params.safeParse(seen);
  if (!parsed.success) return null;
  const { query, version, limit } = parsed.data;
  return {
    query,
    ...(version === undefined ? {} : { version }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function retrievalError(code: RetrievalErrorCode): ApiError {
  // With its flag off the library answers not_found; the route then reads as one that does
  // not exist, the same 404 the guard gives.
  if (code === 'retrieval.not_found') return new ApiError('api.not_found');
  return new ApiError(code);
}

// Field by field, so a field the library adds for its own callers (the assistant's coverage,
// say) never reaches a client by accident.
export function retrieveBody(result: RetrieveResult): RetrieveResult {
  return {
    pin: { version: result.pin.version, publishedAt: result.pin.publishedAt },
    ranking: result.ranking,
    hits: result.hits.map((hit) => ({
      chunkId: hit.chunkId,
      nodeId: hit.nodeId,
      versionId: hit.versionId,
      path: hit.path,
      title: hit.title,
      headingPath: [...hit.headingPath],
      text: hit.text,
      rank: hit.rank,
    })),
  };
}

export type RetrieveService = Pick<Retrieval, 'retrieve'>;

// A thin layer: the guard proves the key, the project, the flag and the plan; the library does
// the rest. The tenant comes from the key, never from a parameter.
export function mountRetrieval(app: Hono<ApiEnv>, deps: ApiDeps, retrieval: RetrieveService) {
  app.get(
    RETRIEVE_PATH,
    guard(deps, {
      scope: RETRIEVE_SCOPE,
      flag: 'retrieval.v1',
      entitled: planFeature(deps.db, 'docs.retrieval_api'),
    }),
    async (c) => {
      const input = parseRetrieveQuery(new URL(c.req.url).searchParams);
      if (input === null) throw new ApiError('retrieval.bad_input');
      const { organizationId, projectId } = tenantOf(c);
      const result = await retrieval.retrieve({ organizationId, projectId }, input);
      if (!result.ok) throw retrievalError(result.error);
      return c.json(retrieveBody(result.value), 200, { 'cache-control': 'no-store' });
    },
  );
}
