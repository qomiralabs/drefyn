import type { ContentSchema } from '@drefyn/schema';
import { execute, lexicographicSortSchema, parse, printSchema, printType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { helperName } from '../src/graphql-names.ts';
import { graphqlEmitter } from '../src/index.ts';
import { CONTEXT, VERSION, emitWith, fakeStore, itemId, put, run } from './graphql-support.ts';
import {
  EMPTY_TREE,
  asset,
  bool,
  date,
  fid,
  list,
  markdown,
  number,
  object,
  reference,
  richText,
  schemaOf,
  text,
  tid,
} from './support.ts';

const ALL_KINDS = schemaOf(
  [
    text(1, { apiName: 'title', required: true }),
    markdown(2, { apiName: 'notes' }),
    richText(3, { apiName: 'body' }),
    number(4, { apiName: 'price' }, { scale: 2 }),
    number(5, { apiName: 'count' }, { scale: 0 }),
    bool(6, { apiName: 'live' }),
    date(7, { apiName: 'day' }, false),
    asset(8, { apiName: 'cover' }),
    reference(9, false, { apiName: 'related' }),
    reference(10, true, { apiName: 'tags' }),
    list(11, text(12, { apiName: 'item' }), 4, { apiName: 'labels' }),
    object(
      13,
      [
        text(14, { apiName: 'heading' }),
        object(15, [bool(16, { apiName: 'on' })], { apiName: 'deep' }),
      ],
      {
        apiName: 'seo',
      },
    ),
    text(17, { apiName: 'old' }),
  ],
  { deprecated: [fid(17)] },
);

const sdlOf = (types: readonly ContentSchema[]) =>
  printSchema(lexicographicSortSchema(emitWith(types, fakeStore())));

const typeText = (types: readonly ContentSchema[], name: string) => {
  const type = emitWith(types, fakeStore()).getType(name);
  if (type === undefined) throw new Error(`no type ${name}`);
  return printType(type);
};

describe('graphqlEmitter types', () => {
  it('maps every field kind, numbers as decimal strings at every scale', () => {
    expect(typeText([ALL_KINDS], '_Fields_article')).toBe(
      [
        'type _Fields_article {',
        '  title: String',
        '  notes: String',
        '  body: _RichText',
        '  price: _Decimal',
        '  count: _Decimal',
        '  live: Boolean',
        '  day: String',
        '  cover: String',
        '  related: article',
        '  tags: [article]',
        '  labels: [String]',
        '  seo: _Object_article_seo',
        '  old: String @deprecated(reason: "Removed from the schema. Served until the removal is confirmed.")',
        '}',
      ].join('\n'),
    );
    expect(typeText([ALL_KINDS], '_Object_article_seo')).toContain(
      'deep: _Object_article_seo_deep',
    );
  });

  it('builds inputs with every field nullable and deprecated fields marked', () => {
    const input = typeText([ALL_KINDS], '_Input_article');
    expect(input).toContain('  title: String\n');
    expect(input).toContain('  tags: [String]\n');
    expect(input).toContain('  seo: _ObjectInput_article_seo\n');
    expect(input).toContain('  old: String @deprecated(');
    expect(input).not.toContain('!');
  });

  it('builds root fields per type, named like the REST operations', () => {
    const sdl = printSchema(emitWith([ALL_KINDS], fakeStore()));
    expect(sdl).toContain(
      'list_article(where: _Where, sort: String, limit: Int = 50, cursor: String): _Page_article!',
    );
    expect(sdl).toContain('get_article(id: String!): article');
    expect(sdl).toContain(
      'create_article(input: _Input_article!, idempotencyKey: String!): article!',
    );
    expect(sdl).toContain(
      'update_article(id: String!, input: _Input_article!, ifMatch: String!): article!',
    );
    expect(sdl).toContain('delete_article(id: String!): Boolean!');
    expect(typeText([ALL_KINDS], 'article')).toBe(
      'type article {\n  id: String!\n  versionId: String!\n  fields: _Fields_article!\n}',
    );
  });

  it('types a reference to several types as a union, and to unknown types as ids', () => {
    const author = schemaOf([text(30)], { typeId: tid(2), apiName: 'author' });
    const article = schemaOf([
      reference(1, false, { apiName: 'by' }, [tid(2), tid(1)]),
      reference(2, false, { apiName: 'any' }, []),
      reference(3, true, { apiName: 'gone' }, [tid(9)]),
    ]);
    const fields = typeText([article, author], '_Fields_article');
    expect(fields).toContain('by: _Ref_article_by');
    expect(fields).toContain('any: _Ref_article_any');
    expect(fields).toContain('gone: [String]');
    expect(sdlOf([article, author])).toContain('union _Ref_article_by = article | author');
  });

  it('resolves union members by their type id', async () => {
    const author = schemaOf([text(30, { apiName: 'name' })], { typeId: tid(2), apiName: 'author' });
    const article = schemaOf([
      reference(1, true, { apiName: 'by' }, [tid(1), tid(2)]),
      reference(2, true, { apiName: 'gone' }, [tid(9)]),
    ]);
    const store = fakeStore();
    const writer = put(store, tid(2), 5, { [fid(30)]: 'Ada' });
    put(store, tid(1), 6, { [fid(1)]: [writer, itemId(6), itemId(404)], [fid(2)]: [itemId(7)] });
    const result = await run(
      emitWith([article, author], store),
      `{ get_article(id: "${itemId(6)}") { fields {
          gone
          by { __typename ... on author { fields { name } } ... on article { id } } } } }`,
    );
    expect(result).toEqual({
      data: {
        get_article: {
          fields: {
            gone: [itemId(7)],
            by: [
              { __typename: 'author', fields: { name: 'Ada' } },
              { __typename: 'article', id: itemId(6) },
              null,
            ],
          },
        },
      },
    });
  });

  it('loads references held in a list', async () => {
    const article = schemaOf([
      list(1, reference(2, false, { apiName: 'item' }), 4, { apiName: 'picks' }),
    ]);
    const store = fakeStore();
    const picked = put(store, tid(1), 3, {});
    put(store, tid(1), 4, { [fid(1)]: [picked, itemId(404)] });
    const result = await run(
      emitWith([article], store),
      `{ get_article(id: "${itemId(4)}") { fields { picks { id } } } }`,
    );
    expect(result).toEqual({
      data: { get_article: { fields: { picks: [{ id: itemId(3) }, null] } } },
    });
    expect(store.calls.load).toEqual([[picked, itemId(404)]]);
  });

  it('refuses two types whose names differ only in case', () => {
    const a = schemaOf([text(1)], { apiName: 'post' });
    const b = schemaOf([text(2)], { typeId: tid(2), apiName: 'Post' });
    expect(() => graphqlEmitter.emit([a, b], fakeStore().resolvers)).toThrow(TypeError);
  });

  it('serves a project with no types yet', async () => {
    const schema = emitWith([], fakeStore());
    expect(schema.getMutationType()).toBeUndefined();
    expect(await run(schema, '{ _empty }')).toEqual({ data: { _empty: null } });
  });

  it('keeps generated names apart from any customer name', () => {
    expect(helperName('Object', 'a_b', ['c'])).toBe('_Object_a__b_c');
    expect(helperName('Object', 'a', ['b_c'])).toBe('_Object_a_b__c');
    expect(helperName('Object', 'a_', ['b'])).toBe('_Object_a___b');
  });
});

describe('graphqlEmitter resolvers', () => {
  it('reads stored values back by field id, in their stored form', async () => {
    const store = fakeStore();
    put(store, tid(1), 1, {
      [fid(1)]: 'Hello',
      [fid(3)]: EMPTY_TREE,
      [fid(4)]: '12.50',
      [fid(6)]: true,
      [fid(11)]: ['a', 'b'],
      [fid(13)]: { [fid(14)]: 'Head', [fid(15)]: { [fid(16)]: false } },
      [fid(17)]: 'kept',
    });
    const result = await run(
      emitWith([ALL_KINDS], store),
      `{ get_article(id: "${itemId(1)}") { id versionId fields {
          title body price count live labels old seo { heading deep { on } } } } }`,
    );
    expect(result).toEqual({
      data: {
        get_article: {
          id: itemId(1),
          versionId: VERSION,
          fields: {
            title: 'Hello',
            body: EMPTY_TREE,
            price: '12.50',
            count: null,
            live: true,
            labels: ['a', 'b'],
            old: 'kept',
            seo: { heading: 'Head', deep: { on: false } },
          },
        },
      },
    });
  });

  it('answers null for an id that is not a uuid without asking the store', async () => {
    const store = fakeStore();
    const result = await run(emitWith([ALL_KINDS], store), '{ get_article(id: "../x") { id } }');
    expect(result).toEqual({ data: { get_article: null } });
    expect(store.calls.get).toEqual([]);
  });

  it('passes list arguments through', async () => {
    const store = fakeStore();
    await run(
      emitWith([ALL_KINDS], store),
      '{ list_article(limit: 5, sort: "title", cursor: "c1") { nextCursor } }',
    );
    expect(store.calls.list).toEqual([{ where: null, sort: 'title', limit: 5, cursor: 'c1' }]);
  });

  it('updates and deletes by id, refusing ids that are not uuids as not found', async () => {
    const store = fakeStore();
    const schema = emitWith([ALL_KINDS], store);
    const updated = await run(
      schema,
      `mutation { update_article(id: "${itemId(1)}", input: {title: "T"}, ifMatch: "v") { fields { title } } }`,
    );
    expect(updated).toEqual({ data: { update_article: { fields: { title: 'T' } } } });
    expect(store.calls.update).toEqual([{ [fid(1)]: 'T' }]);
    const deleted = await run(schema, `mutation { delete_article(id: "${itemId(1)}") }`);
    expect(deleted).toEqual({ data: { delete_article: true } });
    const bad = await run(schema, 'mutation { delete_article(id: "nope") }');
    expect(bad.errors?.[0]?.extensions).toEqual({ code: 'api.not_found' });
    expect(store.calls.delete).toEqual([itemId(1)]);
  });

  it('refuses to run outside runGraphql, where no request state exists', async () => {
    const schema = emitWith([ALL_KINDS], fakeStore());
    const result = await execute({
      schema,
      document: parse(`{ get_article(id: "${itemId(1)}") { id } }`),
      contextValue: CONTEXT,
    });
    expect(result.errors?.[0]?.message).toMatch(/runGraphql/);
  });
});
