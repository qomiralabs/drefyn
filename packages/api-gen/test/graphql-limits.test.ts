import { buildClientSchema, getIntrospectionQuery, type IntrospectionQuery } from 'graphql';
import { describe, expect, it } from 'vitest';
import { GRAPHQL_LIMITS, runGraphql } from '../src/index.ts';
import { CONTEXT, emitWith, fakeStore, itemId, put, run } from './graphql-support.ts';
import { object, reference, schemaOf, text, tid } from './support.ts';

const ARTICLE = schemaOf([
  text(1, { apiName: 'title' }),
  reference(2, false, { apiName: 'related' }),
  reference(3, true, { apiName: 'tags' }),
  object(4, [object(5, [text(6, { apiName: 't' })], { apiName: 'inner' })], { apiName: 'meta' }),
]);

function setup() {
  const store = fakeStore();
  return { store, schema: emitWith([ARTICLE], store) };
}

// Field depth of the leaf: get(1) fields(2) related(3) fields(4) ... leaf.
function nested(references: number, leaf = 'id'): string {
  let inner = leaf;
  for (let i = 0; i < references; i += 1) inner = `fields { related { ${inner} } }`;
  return `{ get_article(id: "${itemId(1)}") { ${inner} } }`;
}

const refused = (code: string) => ({
  errors: [{ message: expect.any(String) as unknown, extensions: { code } }],
});

describe('depth limit', () => {
  it('runs a query at exactly the limit', async () => {
    const { store, schema } = setup();
    put(store, tid(1), 1, {});
    // get, then three references of two levels each, then id: depth 8.
    const result = await run(schema, nested(3));
    expect(result.errors).toBeUndefined();
    expect(store.calls.get).toHaveLength(1);
  });

  it('refuses one level past the limit before any resolver runs', async () => {
    const { store, schema } = setup();
    // fields at 8, title at 9.
    expect(await run(schema, nested(3, 'fields { title }'))).toEqual(refused('api.query_too_deep'));
    expect(await run(schema, nested(20))).toEqual(refused('api.query_too_deep'));
    expect(store.total()).toBe(0);
  });

  it('counts depth through fragments and inline fragments', async () => {
    const { store, schema } = setup();
    const query = `
      query { get_article(id: "${itemId(1)}") { ...A } }
      fragment A on article { fields { related { ...B } } }
      fragment B on article { fields { related { ... on article { fields { related {
        fields { related { id } } } } } } } }
    `;
    expect(await run(schema, query)).toEqual(refused('api.query_too_deep'));
    expect(store.total()).toBe(0);
  });

  it('refuses deeply nested variables without walking them recursively', async () => {
    const { store, schema } = setup();
    let where: Record<string, unknown> = { field: 'title', op: 'exists' };
    for (let i = 0; i < 100_000; i += 1) where = { not: where };
    const query = 'query Q($w: _Where) { list_article(where: $w) { nextCursor } }';
    expect(await run(schema, query, { w: where })).toEqual(refused('api.query_too_deep'));
    expect(store.total()).toBe(0);
  });
});

describe('complexity limit', () => {
  it('prices a full page with one reference each under the limit', async () => {
    const { store, schema } = setup();
    // 100 items, each reading one related item: 200.
    const query = '{ list_article(limit: 100) { items { fields { related { id } } } } }';
    expect((await run(schema, query)).errors).toBeUndefined();
    expect(store.calls.list).toHaveLength(1);
  });

  it('refuses a page whose many references could read more than the limit', async () => {
    const { store, schema } = setup();
    // 100 items, each up to 10 tags: 1,100.
    const query = '{ list_article(limit: 100) { items { fields { tags { id } } } } }';
    expect(await run(schema, query)).toEqual(refused('api.query_too_complex'));
    expect(store.total()).toBe(0);
  });

  it('reads the page size from a variable', async () => {
    const { store, schema } = setup();
    const query =
      'query Q($n: Int) { list_article(limit: $n) { items { fields { tags { id } } } } }';
    expect((await run(schema, query, { n: 50 })).errors).toBeUndefined();
    expect(await run(schema, query, { n: 100 })).toEqual(refused('api.query_too_complex'));
    expect(store.calls.list).toHaveLength(1);
  });

  it('refuses a page size outside 1 to 100 before running', async () => {
    const { store, schema } = setup();
    for (const limit of ['0', '101', '-1']) {
      const query = `{ list_article(limit: ${limit}) { nextCursor } }`;
      expect(await run(schema, query)).toEqual(refused('api.query_invalid'));
    }
    const query = 'query Q($n: Int) { list_article(limit: $n) { nextCursor } }';
    expect(await run(schema, query, { n: 1000 })).toEqual(refused('api.query_invalid'));
    expect(store.total()).toBe(0);
  });

  it('adds up aliased root fields', async () => {
    const { schema } = setup();
    const one = (n: number) => `a${String(n)}: list_article(limit: 100) { items { id } }`;
    const ten = Array.from({ length: 10 }, (_, n) => one(n)).join(' ');
    expect((await run(schema, `{ ${ten} }`)).errors).toBeUndefined();
    const eleven = Array.from({ length: 11 }, (_, n) => one(n)).join(' ');
    expect(await run(schema, `{ ${eleven} }`)).toEqual(refused('api.query_too_complex'));
  });
});

describe('alias and size limits', () => {
  it('refuses more aliases than the limit, even of free fields', async () => {
    const { store, schema } = setup();
    const aliases = (n: number) =>
      Array.from({ length: n }, (_, i) => `t${String(i)}: __typename`).join(' ');
    expect((await run(schema, `{ ${aliases(GRAPHQL_LIMITS.maxAliases)} }`)).errors).toBeUndefined();
    expect(await run(schema, `{ ${aliases(GRAPHQL_LIMITS.maxAliases + 1)} }`)).toEqual(
      refused('api.query_too_complex'),
    );
    expect(store.total()).toBe(0);
  });

  it('counts aliases inside a fragment once per spread', async () => {
    const { schema } = setup();
    const inside = Array.from({ length: 10 }, (_, i) => `x${String(i)}: id`).join(' ');
    const spreads = Array.from(
      { length: 6 },
      (_, i) => `g${String(i)}: get_article(id: "${itemId(1)}") { ...F }`,
    ).join(' ');
    const query = `{ ${spreads} } fragment F on article { ${inside} }`;
    expect(await run(schema, query)).toEqual(refused('api.query_too_complex'));
  });

  it('refuses a fan out of repeated references as too complex', async () => {
    const { store, schema } = setup();
    const many = (n: number, field: string) => Array.from({ length: n }, () => field).join(' ');
    const query = [
      `{ get_article(id: "${itemId(1)}") { fields { ...L0 } } }`,
      `fragment L0 on _Fields_article { ${many(30, 'related { fields { ...L1 } }')} }`,
      `fragment L1 on _Fields_article { ${many(30, 'related { fields { ...L2 } }')} }`,
      `fragment L2 on _Fields_article { ${many(30, 'related { id }')} }`,
    ].join('\n');
    expect(await run(schema, query)).toEqual(refused('api.query_too_complex'));
    expect(store.total()).toBe(0);
  });

  it('stops a fan out of free fields at the visit cap', async () => {
    const { store, schema } = setup();
    const many = (n: number, field: string) => Array.from({ length: n }, () => field).join(' ');
    // Nothing here reads storage, so only the walk's own cap can stop it.
    const query = [
      `{ get_article(id: "${itemId(1)}") { fields { ...M0 } } }`,
      `fragment M0 on _Fields_article { ${many(25, 'meta { ...M1 }')} }`,
      `fragment M1 on _Object_article_meta { ${many(25, 'inner { ...M2 }')} }`,
      `fragment M2 on _Object_article_meta_inner { ${many(25, 't')} }`,
    ].join('\n');
    expect(await run(schema, query)).toEqual(refused('api.query_too_complex'));
    expect(store.total()).toBe(0);
  });

  it('refuses a document past the token limit', async () => {
    const { store, schema } = setup();
    const fields = Array.from({ length: GRAPHQL_LIMITS.maxTokens }, () => '__typename').join(' ');
    expect(await run(schema, `{ ${fields} }`)).toEqual(refused('api.query_invalid'));
    expect(store.total()).toBe(0);
  });

  it('refuses a deeply nested literal without a crash', async () => {
    const { store, schema } = setup();
    let where = '{field: "title", op: exists}';
    for (let i = 0; i < 2_000; i += 1) where = `{not: ${where}}`;
    const result = await run(schema, `{ list_article(where: ${where}) { nextCursor } }`);
    expect(result.errors?.[0]?.extensions.code).toMatch(/^api\.(query_invalid|filter_invalid)$/);
    expect(store.calls.list).toHaveLength(0);
  });

  it('refuses malformed requests', async () => {
    const { schema } = setup();
    for (const request of [
      null,
      'query',
      { query: '' },
      { query: '{ __typename }', extra: 1 },
      { query: '{ __typename }', variables: [] },
      { query: 'x'.repeat(GRAPHQL_LIMITS.maxQueryLength + 1) },
      { query: '{ nope }' },
      { query: '{' },
      { query: 'query A { __typename } query B { __typename }' },
      { query: '{ __typename }', operationName: 'Missing' },
      { query: 'subscription { __typename }' },
    ]) {
      expect(await runGraphql(schema, request, CONTEXT, { introspection: true })).toEqual(
        refused('api.query_invalid'),
      );
    }
  });

  it('refuses variables of the wrong type as a validation failure', async () => {
    const { store, schema } = setup();
    const query = 'query Q($n: Int) { list_article(limit: $n) { nextCursor } }';
    expect(await run(schema, query, { n: 'ten' })).toEqual(refused('api.validation_failed'));
    expect(store.total()).toBe(0);
  });
});

describe('introspection', () => {
  const hidden = [
    '{ __schema { queryType { name } } }',
    '{ __type(name: "article") { name } }',
    '{ ...I } fragment I on Query { __schema { types { name } } }',
    '{ ... on Query { __type(name: "Query") { name } } }',
  ];

  it.each(hidden)('is refused when turned off: %s', async (query) => {
    const { store, schema } = setup();
    expect(await run(schema, query, undefined, false)).toEqual(
      refused('api.introspection_disabled'),
    );
    expect(store.total()).toBe(0);
  });

  it('still answers __typename when turned off', async () => {
    const { schema } = setup();
    expect(await run(schema, '{ __typename }', undefined, false)).toEqual({
      data: { __typename: 'Query' },
    });
  });

  it('answers the full standard introspection query when on', async () => {
    const { schema } = setup();
    const result = await run(schema, getIntrospectionQuery(), undefined, true);
    expect(result.errors).toBeUndefined();
    const client = buildClientSchema(result.data as unknown as IntrospectionQuery);
    expect(client.getType('article')).toBeDefined();
  });

  it('keeps the content depth limit inside a query that also introspects', async () => {
    const { schema } = setup();
    const query = nested(4).replace(
      '{ get_article',
      '{ __schema { queryType { name } } get_article',
    );
    expect(await run(schema, query, undefined, true)).toEqual(refused('api.query_too_deep'));
  });
});
