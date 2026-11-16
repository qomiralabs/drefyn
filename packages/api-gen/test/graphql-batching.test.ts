import type { ContentSchema } from '@drefyn/schema';
import { describe, expect, it } from 'vitest';
import { createBatchLoader } from '../src/batch-loader.ts';
import { ContentApiError } from '../src/index.ts';
import { emitWith, fakeStore, itemId, put, run } from './graphql-support.ts';
import { reference, schemaOf, text, tid } from './support.ts';

const COMPANY: ContentSchema = schemaOf([text(30, { apiName: 'name' })], {
  typeId: tid(3),
  apiName: 'company',
});
const AUTHOR: ContentSchema = schemaOf(
  [text(20, { apiName: 'name' }), reference(21, false, { apiName: 'company' }, [tid(3)])],
  { typeId: tid(2), apiName: 'author' },
);
const ARTICLE: ContentSchema = schemaOf([
  text(10, { apiName: 'title' }),
  reference(11, false, { apiName: 'author' }, [tid(2)]),
  reference(12, true, { apiName: 'tags' }, [tid(3)]),
]);

// 100 articles, each by its own author, each author at one of 100 companies.
function seeded() {
  const store = fakeStore();
  for (let n = 0; n < 100; n += 1) {
    const company = put(store, tid(3), 3000 + n, {
      [String(COMPANY.fields[0]?.id)]: `c${String(n)}`,
    });
    const author = put(store, tid(2), 2000 + n, {
      [String(AUTHOR.fields[1]?.id)]: company,
    });
    put(store, tid(1), 1000 + n, {
      [String(ARTICLE.fields[1]?.id)]: author,
      [String(ARTICLE.fields[2]?.id)]: [company, itemId(3000 + ((n + 1) % 100))],
    });
  }
  return { store, schema: emitWith([ARTICLE, AUTHOR, COMPANY], store) };
}

describe('reference batching', () => {
  it('makes one load call per level across 100 nodes', async () => {
    const { store, schema } = seeded();
    const result = await run(
      schema,
      `{ list_article(limit: 100) { items { fields { author { id fields {
          company { id fields { name } } } } } } } }`,
    );
    expect(result.errors).toBeUndefined();
    expect(store.calls.list).toHaveLength(1);
    // Level one: 100 authors. Level two: 100 companies.
    expect(store.calls.load.map((ids) => ids.length)).toEqual([100, 100]);
    const items = (result.data as { list_article: { items: unknown[] } }).list_article.items;
    expect(items).toHaveLength(100);
    expect(items[7]).toEqual({
      fields: {
        author: {
          id: itemId(2007),
          fields: { company: { id: itemId(3007), fields: { name: 'c7' } } },
        },
      },
    });
  });

  it('loads each id once per request, across fields and levels', async () => {
    const { store, schema } = seeded();
    const result = await run(
      schema,
      `{ list_article(limit: 50) { items { fields {
          tags { id } author { fields { company { id } } } } } } }`,
    );
    expect(result.errors).toBeUndefined();
    const all = store.calls.load.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(store.calls.load.length).toBeLessThanOrEqual(2);
  });

  it('reads a reference to a type it does not allow as null', async () => {
    const store = fakeStore();
    const company = put(store, tid(3), 1, {});
    put(store, tid(1), 2, { [String(ARTICLE.fields[1]?.id)]: company });
    const schema = emitWith([ARTICLE, AUTHOR, COMPANY], store);
    const result = await run(
      schema,
      `{ get_article(id: "${itemId(2)}") { fields { author { id } } } }`,
    );
    expect(result).toEqual({ data: { get_article: { fields: { author: null } } } });
  });

  it('starts a fresh cache for every request', async () => {
    const { store, schema } = seeded();
    const query = `{ get_article(id: "${itemId(1000)}") { fields { author { id } } } }`;
    await run(schema, query);
    await run(schema, query);
    expect(store.calls.load).toEqual([[itemId(2000)], [itemId(2000)]]);
  });
});

describe('createBatchLoader', () => {
  const echo = (calls: (readonly string[])[]) => (keys: readonly string[]) => {
    calls.push(keys);
    return Promise.resolve(keys.map((key) => (key === 'missing' ? null : `v:${key}`)));
  };

  it('splits a level into calls of at most maxBatch keys', async () => {
    const calls: (readonly string[])[] = [];
    const loader = createBatchLoader(echo(calls), { maxBatch: 2, maxKeys: 10 });
    const values = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((key) => loader.load(key)));
    expect(values).toEqual(['v:a', 'v:b', 'v:c', 'v:d', 'v:e']);
    expect(calls).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('answers null for a key the source does not have', async () => {
    const loader = createBatchLoader(echo([]), { maxBatch: 5, maxKeys: 5 });
    expect(await loader.load('missing')).toBeNull();
  });

  it('refuses keys past the per request cap instead of queueing them', async () => {
    const loader = createBatchLoader(echo([]), { maxBatch: 5, maxKeys: 2 });
    await Promise.all([loader.load('a'), loader.load('b')]);
    expect(await loader.load('a')).toBe('v:a');
    const refused = loader.load('c');
    await expect(refused).rejects.toBeInstanceOf(ContentApiError);
    await expect(refused).rejects.toMatchObject({ code: 'api.query_too_complex' });
  });

  it('fails every key in a batch when the source fails or answers short', async () => {
    const failing = createBatchLoader(() => Promise.reject(new Error('down')), {
      maxBatch: 5,
      maxKeys: 5,
    });
    const both = [failing.load('a'), failing.load('b')];
    for (const promise of both) await expect(promise).rejects.toThrow('down');
    const short = createBatchLoader(() => Promise.resolve(['only one']), {
      maxBatch: 5,
      maxKeys: 5,
    });
    const pair = [short.load('a'), short.load('b')];
    for (const promise of pair) await expect(promise).rejects.toThrow(/length/);
  });
});
