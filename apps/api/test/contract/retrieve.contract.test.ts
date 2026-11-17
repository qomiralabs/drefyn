import type * as DbModule from '@drefyn/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RetrievalErrorCode, RetrieveResult } from '@drefyn/retrieval';
import { idOf, toPublicId, type OrganizationId, type ProjectId } from '@drefyn/tenancy';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildOpenApi, RETRIEVE_OPERATION_PATH } from '../../src/openapi.ts';
import { DOCS_KEY, fakeRetrieval, retrievalApp, STUDIO_KEY } from '../retrieval-support.ts';
import { DOCS_PROJECT, ORG, socketEnv } from '../support.ts';

vi.mock('@drefyn/db', async (original) => {
  const actual = await original<typeof DbModule>();
  return {
    ...actual,
    withOrganization: (
      _db: unknown,
      org: { organizationId: OrganizationId },
      work: (tx: unknown) => Promise<unknown>,
    ) => {
      let table = '';
      let id = '' as ProjectId;
      const chain = {
        selectFrom: (name: string) => {
          table = name;
          return chain;
        },
        select: () => chain,
        where: (column: string, _op: string, value: string) => {
          if (column === 'id') id = value as ProjectId;
          return chain;
        },
        executeTakeFirst: () =>
          Promise.resolve(
            table === 'organizations'
              ? { plan_tier: 'growth' }
              : org.organizationId === ORG && id === DOCS_PROJECT
                ? { product: 'docs' }
                : undefined,
          ),
      };
      return work(chain);
    },
  };
});

// The document clients read, as committed. The tests below hold the route to it, not to the
// code that wrote it.
const PUBLISHED = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', '..', 'openapi', 'v1.json'), 'utf8'),
) as Record<string, unknown>;

interface Operation {
  readonly parameters: readonly { readonly name: string; readonly in: string }[];
  readonly responses: Readonly<
    Record<string, { readonly content: { 'application/json': { readonly schema: unknown } } }>
  >;
}

function operation(): Operation {
  const paths = PUBLISHED['paths'] as Record<string, { get?: Operation } | undefined>;
  const op = paths[RETRIEVE_OPERATION_PATH]?.get;
  if (op === undefined) throw new Error('the document has no retrieve operation');
  return op;
}

function schemaFor(status: number): z.ZodType {
  const response = operation().responses[String(status)];
  if (response === undefined) throw new Error(`the document has no ${String(status)} response`);
  return z.fromJSONSchema(response.content['application/json'].schema as never);
}

const url = (query: string) => `/v1/projects/${toPublicId('prj', DOCS_PROJECT)}/retrieve${query}`;

async function get(app: ReturnType<typeof retrievalApp>['app'], query: string, key = DOCS_KEY) {
  const response = await app.request(url(query), { headers: { authorization: key } }, socketEnv());
  return { status: response.status, body: await response.json() };
}

const uuid = fc.uuid({ version: 7 });
const words = fc.string({ minLength: 0, maxLength: 60 });

// Library results of every shape the type allows.
const results: fc.Arbitrary<RetrieveResult> = fc.record({
  pin: fc.record({
    version: fc.constant('latest'),
    publishedAt: fc
      .date({
        min: new Date('2020-01-01T00:00:00Z'),
        max: new Date('2100-01-01T00:00:00Z'),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString()),
  }),
  ranking: fc.constantFrom('lexical' as const, 'hybrid' as const),
  hits: fc
    .array(
      fc.record({
        chunkId: uuid,
        nodeId: uuid.map((id) => idOf('nod', id)),
        versionId: uuid.map((id) => idOf('ver', id)),
        path: words.map((w) => `/${w}`),
        title: words,
        headingPath: fc.array(words, { maxLength: 4 }),
        text: words,
      }),
      { maxLength: 20 },
    )
    .map((hits) => hits.map((hit, at) => ({ ...hit, rank: at + 1 }))),
});

describe('the published OpenAPI document', () => {
  it('is what the code describes, so a route change cannot skip the document', () => {
    expect(PUBLISHED).toEqual(buildOpenApi());
  });

  it('is built the same way every time', () => {
    expect(JSON.stringify(buildOpenApi())).toBe(JSON.stringify(buildOpenApi()));
  });

  it('documents the three parameters, the project and a bearer key', () => {
    expect(operation().parameters.map((p) => `${p.in}:${p.name}`)).toEqual([
      'path:projectId',
      'query:query',
      'query:version',
      'query:limit',
    ]);
    const security = (PUBLISHED['paths'] as Record<string, { get: { security: unknown } }>)[
      RETRIEVE_OPERATION_PATH
    ]?.get.security;
    expect(security).toEqual([{ apiKey: [] }]);
  });

  it('documents every status the route answers', () => {
    expect(Object.keys(operation().responses).sort()).toEqual(
      ['200', '400', '401', '403', '404', '413', '429', '500', '503'].sort(),
    );
  });
});

describe('responses match the published document', () => {
  it('every success body the route can send', async () => {
    await fc.assert(
      fc.asyncProperty(results, async (value) => {
        const { app } = retrievalApp({}, fakeRetrieval({ ok: true, value }));
        const answer = await get(app, '?query=install');
        expect(answer.status).toBe(200);
        const checked = schemaFor(200).safeParse(answer.body);
        expect(checked.error?.issues ?? []).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });

  it('a body with a field the document lacks would fail it', () => {
    expect(schemaFor(200).safeParse({ pin: {}, ranking: 'lexical', hits: [] }).success).toBe(false);
    const extra = {
      pin: { version: 'latest', publishedAt: '2026-11-17T10:00:00.000Z' },
      ranking: 'lexical',
      hits: [],
      coverage: 0.5,
    };
    expect(schemaFor(200).safeParse(extra).success).toBe(false);
  });

  it('every refusal the route can send, under the status the document gives it', async () => {
    const answers: [string, RetrievalErrorCode | null, string, string?][] = [
      ['bad parameters', null, '?limit=0'],
      ['library bad_input', 'retrieval.bad_input', '?query=a'],
      ['unknown version', 'retrieval.version_not_found', '?query=a&version=v9'],
      ['flag off in the library', 'retrieval.not_found', '?query=a'],
      ['busy', 'retrieval.busy', '?query=a'],
      ['unavailable', 'retrieval.unavailable', '?query=a'],
      ['wrong scope', null, '?query=a', STUDIO_KEY],
      ['bad key', null, '?query=a', 'Bearer nope'],
    ];
    for (const [label, error, query, key] of answers) {
      const { app } = retrievalApp(
        {},
        error === null ? fakeRetrieval() : fakeRetrieval({ ok: false, error }),
      );
      const answer = await get(app, query, key);
      expect(answer.status, label).not.toBe(200);
      const checked = schemaFor(answer.status).safeParse(answer.body);
      expect(checked.error?.issues ?? [], label).toEqual([]);
    }
  });
});
