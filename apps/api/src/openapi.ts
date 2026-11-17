import { z } from 'zod';
import { errorBody, type ApiErrorCode } from './errors.ts';
import { MAX_LIMIT, MAX_QUERY_LENGTH, MAX_VERSION_LENGTH, RETRIEVE_SCOPE } from './retrieve.ts';

export const RETRIEVE_OPERATION_PATH = '/v1/projects/{projectId}/retrieve';

const hit = z.strictObject({
  chunkId: z.uuid(),
  nodeId: z.uuid(),
  versionId: z.uuid().describe('The published page version the text came from.'),
  path: z.string().describe('Page path at publish.'),
  title: z.string(),
  headingPath: z.array(z.string()),
  text: z.string().describe('Reader text only, never source or HTML.'),
  rank: z
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .describe('1 based position. Scores are not exposed, so ranking can change.'),
});

export const retrieveResponse = z.strictObject({
  pin: z.strictObject({
    version: z.string(),
    publishedAt: z.iso
      .datetime({ offset: true })
      .describe('The newest publish in the set read, ISO 8601.'),
  }),
  ranking: z.enum(['lexical', 'hybrid']),
  hits: z.array(hit).max(MAX_LIMIT),
});

interface Refusal {
  // The first code is the example.
  readonly codes: readonly [ApiErrorCode, ...ApiErrorCode[]];
  readonly description: string;
}

// Each status with the codes the route can answer under it, so a client can switch on both.
const REFUSALS: Readonly<Record<string, Refusal>> = {
  '400': {
    codes: ['retrieval.bad_input'],
    description: 'A parameter is missing, repeated, unknown or out of range.',
  },
  '401': {
    codes: ['auth.api_key_invalid'],
    description: 'No key, a bad, revoked or expired key, or a key in the query string.',
  },
  '403': {
    codes: ['auth.api_key_scope', 'api.not_entitled'],
    description: 'The key lacks the scope or the project, or the plan lacks the feature.',
  },
  '404': {
    codes: ['api.not_found', 'retrieval.version_not_found'],
    description: 'No such project for this key, the feature is off, or no such version.',
  },
  '413': { codes: ['api.too_large'], description: 'The request is too large.' },
  '429': {
    codes: ['auth.rate_limited'],
    description: 'Too many failed requests from this client. Honour Retry-After.',
  },
  '500': { codes: ['api.internal'], description: 'Something went wrong on our side.' },
  '503': {
    codes: ['auth.unavailable', 'api.unavailable', 'retrieval.busy', 'retrieval.unavailable'],
    description: 'Try again after the Retry-After header.',
  },
};

const errorSchema = (codes: Refusal['codes']) =>
  z.strictObject({ error: z.strictObject({ code: z.enum(codes), message: z.string() }) });

// Without the $schema line zod adds: inside an OpenAPI 3.1 document that dialect is the default.
function inline(schema: z.ZodType): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output', unrepresentable: 'throw' }),
  };
  delete out['$schema'];
  return out;
}

// Plain data, built the same way every call, so the committed copy can be compared to it.
export function buildOpenApi(): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    '200': {
      description: 'Ranked passages from the published docs, pinned to a version.',
      headers: { 'cache-control': { schema: { type: 'string', const: 'no-store' } } },
      content: { 'application/json': { schema: inline(retrieveResponse) } },
    },
  };
  for (const [status, { codes, description }] of Object.entries(REFUSALS)) {
    responses[status] = {
      description,
      ...(status === '429' || status === '503'
        ? { headers: { 'retry-after': { schema: { type: 'integer', minimum: 1 } } } }
        : {}),
      content: {
        'application/json': { schema: inline(errorSchema(codes)), example: errorBody(codes[0]) },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Drefyn API',
      version: '1',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: 'https://api.drefyn.com', description: 'Hosted' }],
    components: {
      securitySchemes: {
        apiKey: {
          type: 'http',
          scheme: 'bearer',
          description: `An organization API key with project scope. Retrieval needs ${RETRIEVE_SCOPE}.`,
        },
      },
    },
    paths: {
      [RETRIEVE_OPERATION_PATH]: {
        get: {
          operationId: 'retrieve',
          summary: 'Retrieve passages from published docs',
          description:
            'Any word, ranked by relevance. Reads only published, public pages: protected ' +
            'pages, drafts and replaced versions are never returned. A question with no words ' +
            '(punctuation only) returns no hits, not an error.',
          security: [{ apiKey: [] }],
          parameters: [
            {
              name: 'projectId',
              in: 'path',
              required: true,
              schema: { type: 'string', pattern: '^prj_[0-9a-hjkmnp-tv-z]{26}$' },
            },
            {
              name: 'query',
              in: 'query',
              required: true,
              description: '1 to 512 characters after trimming.',
              schema: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
            },
            {
              name: 'version',
              in: 'query',
              required: false,
              description: 'A published version label. Only latest exists today.',
              schema: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_VERSION_LENGTH,
                default: 'latest',
              },
            },
            {
              name: 'limit',
              in: 'query',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: 8 },
            },
          ],
          responses,
        },
      },
    },
  };
}
