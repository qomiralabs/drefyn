import { describe, expect, it } from 'vitest';
import {
  CONTENT_ERROR_CODES,
  ContentApiError,
  GRAPHQL_ERROR_CODES,
  compileValidator,
  emitOpenApi,
  graphqlEmitter,
  parseFilterParam,
  type ContentErrorCode,
  type ResolverSet,
} from '../src/index.ts';
import { ERROR_MESSAGES } from '../src/errors.ts';
import { emitWith, fakeStore, itemId, run } from './graphql-support.ts';
import { number, schemaOf, text } from './support.ts';

const ARTICLE = schemaOf([
  text(1, { apiName: 'title', required: true, filterable: true }),
  number(2, { apiName: 'price' }, { min: '0', max: '10' }),
]);

function throwing(error: Error): ResolverSet {
  const store = fakeStore();
  return { ...store.resolvers, get: () => Promise.reject(error) };
}

const GET = `{ get_article(id: "${itemId(1)}") { id } }`;

describe('error codes in extensions', () => {
  it('lists the same codes the REST document does', () => {
    const doc = emitOpenApi([ARTICLE], {
      serverUrl: 'https://api.example.test',
      title: 'T',
      schemaVersion: 1,
    }) as unknown as {
      components: {
        schemas: { error: { properties: { error: { properties: { code: { enum: string[] } } } } } };
      };
    };
    expect(doc.components.schemas.error.properties.error.properties.code.enum).toEqual([
      ...CONTENT_ERROR_CODES,
    ]);
  });

  it.each(CONTENT_ERROR_CODES.map((code) => [code]))(
    'a resolver refusing with %s answers with that code and fixed text',
    async (code: ContentErrorCode) => {
      const schema = graphqlEmitter.emit([ARTICLE], throwing(new ContentApiError(code)));
      const result = await run(schema, GET);
      expect(result).toEqual({
        data: { get_article: null },
        errors: [
          {
            message: ERROR_MESSAGES[code],
            path: ['get_article'],
            locations: [{ line: 1, column: 3 }],
            extensions: { code },
          },
        ],
      });
    },
  );

  it('gives every code its own fixed message', () => {
    const codes = [...CONTENT_ERROR_CODES, ...GRAPHQL_ERROR_CODES];
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...codes].sort());
    expect(new Set(Object.values(ERROR_MESSAGES)).size).toBe(codes.length);
  });

  it('hides anything else a resolver throws behind api.internal', async () => {
    const secret = new Error('connection to db-7.internal refused for user admin');
    const schema = graphqlEmitter.emit([ARTICLE], throwing(secret));
    const result = await run(schema, GET);
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: ERROR_MESSAGES['api.internal'],
        extensions: { code: 'api.internal' },
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('db-7');
  });

  it('answers a bad write with the validator issues as fields', async () => {
    const input = { price: '11', extra: 'x' };
    const store = fakeStore();
    const result = await run(
      emitWith([ARTICLE], store),
      'mutation M($i: _Input_article!) { create_article(input: $i, idempotencyKey: "k") { id } }',
      { i: { price: '11' } },
    );
    const expected = compileValidator(ARTICLE)({ price: '11' });
    expect(expected.ok).toBe(false);
    if (expected.ok) return;
    expect(result.errors?.[0]?.extensions).toEqual({
      code: 'api.validation_failed',
      fields: expected.error,
    });
    expect(expected.error).toEqual([
      { path: 'price', code: 'field.range' },
      { path: 'title', code: 'field.required' },
    ]);
    // An unknown key is refused by GraphQL's own input type, before the validator.
    const unknown = await run(
      emitWith([ARTICLE], store),
      'mutation M($i: _Input_article!) { create_article(input: $i, idempotencyKey: "k") { id } }',
      { i: input },
    );
    expect(unknown.errors?.[0]?.extensions).toEqual({ code: 'api.validation_failed' });
    expect(store.calls.create).toEqual([]);
  });

  it('answers a bad filter with the filter parameter fields', async () => {
    const store = fakeStore();
    const result = await run(
      emitWith([ARTICLE], store),
      '{ list_article(where: {field: "price", op: contains, value: "1"}) { nextCursor } }',
    );
    const expected = parseFilterParam(
      ARTICLE,
      JSON.stringify({ field: 'price', op: 'contains', value: '1' }),
    );
    expect(expected.ok).toBe(false);
    if (expected.ok) return;
    expect(result.errors?.[0]?.extensions).toEqual({
      code: 'api.filter_invalid',
      fields: expected.error.fields,
    });
  });

  it('leaves sibling fields standing when one nullable field fails', async () => {
    const schema = graphqlEmitter.emit([ARTICLE], throwing(new ContentApiError('api.forbidden')));
    const result = await run(schema, `{ a: get_article(id: "${itemId(1)}") { id } b: __typename }`);
    expect(result.data).toEqual({ a: null, b: 'Query' });
    expect(result.errors).toHaveLength(1);
  });
});
