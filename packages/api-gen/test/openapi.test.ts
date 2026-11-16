import { describe, expect, it } from 'vitest';
import { emitOpenApi, type JsonValue } from '../src/index.ts';
import {
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

const OPTIONS = { serverUrl: 'https://api.example.test', title: 'Acme content', schemaVersion: 7 };

const ARTICLE = schemaOf(
  [
    text(1, { apiName: 'title', required: true }, { maxLength: 120 }),
    text(2, { apiName: 'slug' }, { format: 'slug' }),
    text(3, { apiName: 'contact' }, { format: 'email' }),
    text(4, { apiName: 'site' }, { format: 'url' }),
    markdown(5, { apiName: 'notes' }),
    richText(6, { apiName: 'body' }),
    number(7, { apiName: 'price' }, { scale: 2, min: '0', max: '99.99' }),
    number(8, { apiName: 'count' }, { scale: 0 }),
    bool(9, { apiName: 'live' }),
    date(10, { apiName: 'published' }, true),
    date(11, { apiName: 'day' }, false),
    asset(12, { apiName: 'hero' }),
    reference(13, false, { apiName: 'author' }),
    reference(14, true, { apiName: 'related' }),
    list(15, text(16, { apiName: 'item' }, { maxLength: 20 }), 5, { apiName: 'tags' }),
    object(17, [text(18, { apiName: 'name', required: true }), bool(19, { apiName: 'on' })], {
      apiName: 'meta',
    }),
    text(20, { apiName: 'legacy' }),
  ],
  { deprecated: [fid(20)] },
);

const AUTHOR = schemaOf([text(30, { apiName: 'name', required: true })], {
  typeId: tid(2),
  apiName: 'author',
});

const at = (value: JsonValue | undefined, ...path: string[]): JsonValue | undefined => {
  let node = value;
  for (const key of path) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, JsonValue>)[key];
  }
  return node;
};

describe('emitOpenApi', () => {
  const doc = emitOpenApi([ARTICLE, AUTHOR], OPTIONS) as unknown as JsonValue;
  const props = (name: string) => at(doc, 'components', 'schemas', name, 'properties');
  // Parameters are shared components; each operation holds references to them.
  const parameters = (op: JsonValue | undefined) =>
    (at(op, 'parameters') as JsonValue[]).map((p) => {
      const target = at(p, '$ref');
      expect(typeof target).toBe('string');
      const name = typeof target === 'string' ? target.replace('#/components/parameters/', '') : '';
      return at(doc, 'components', 'parameters', name);
    });

  it('is OpenAPI 3.1 with the server, title and schema version', () => {
    expect(at(doc, 'openapi')).toBe('3.1.0');
    expect(at(doc, 'info')).toEqual({ title: 'Acme content', version: '7' });
    expect(at(doc, 'servers')).toEqual([{ url: 'https://api.example.test' }]);
  });

  it('lists the routes for each type under /v1', () => {
    const paths = Object.keys(at(doc, 'paths') as object);
    expect(paths).toEqual([
      '/v1/projects/{projectId}/content/article',
      '/v1/projects/{projectId}/content/article/{id}',
      '/v1/projects/{projectId}/content/author',
      '/v1/projects/{projectId}/content/author/{id}',
    ]);
    const list = at(doc, 'paths', '/v1/projects/{projectId}/content/article');
    expect(Object.keys(list as object)).toEqual(['get', 'post']);
    const one = at(doc, 'paths', '/v1/projects/{projectId}/content/article/{id}');
    expect(Object.keys(one as object)).toEqual(['delete', 'get', 'patch']);
    expect(at(list, 'get', 'operationId')).toBe('list_article');
    expect(at(list, 'post', 'operationId')).toBe('create_article');
  });

  it('needs an Idempotency-Key on create and If-Match on update', () => {
    const post = at(doc, 'paths', '/v1/projects/{projectId}/content/article', 'post');
    const patch = at(doc, 'paths', '/v1/projects/{projectId}/content/article/{id}', 'patch');
    const header = (op: JsonValue | undefined, name: string) =>
      parameters(op).find((p) => at(p, 'name') === name);
    expect(at(header(post, 'Idempotency-Key'), 'required')).toBe(true);
    expect(at(header(patch, 'If-Match'), 'required')).toBe(true);
  });

  it('describes list query parameters with their limits', () => {
    const get = at(doc, 'paths', '/v1/projects/{projectId}/content/article', 'get');
    const names = parameters(get).map((p) => at(p, 'name'));
    expect(names).toEqual(['projectId', 'cursor', 'depth', 'filter', 'limit', 'sort', 'version']);
    const depth = parameters(get).find((p) => at(p, 'name') === 'depth');
    expect(at(depth, 'schema')).toEqual({ default: 1, maximum: 3, minimum: 0, type: 'integer' });
  });

  it('maps each field kind', () => {
    const p = props('content.article.fields');
    expect(at(p, 'title')).toEqual({ type: 'string', 'x-drefyn-max-bytes': 120 });
    expect(at(p, 'slug', 'pattern')).toBe('^[a-z0-9]+(?:-[a-z0-9]+)*$');
    expect(at(p, 'contact', 'format')).toBe('email');
    expect(at(p, 'site', 'format')).toBe('uri');
    expect(at(p, 'notes')).toEqual({
      contentMediaType: 'text/markdown',
      type: 'string',
      'x-drefyn-max-bytes': 1000,
    });
    expect(at(p, 'body')).toEqual({ $ref: '#/components/schemas/richText' });
    expect(at(p, 'price')).toEqual({
      pattern: '^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,2})?$',
      type: 'string',
      'x-drefyn-max': '99.99',
      'x-drefyn-min': '0',
      'x-drefyn-scale': 2,
    });
    expect(at(p, 'count', 'pattern')).toBe('^-?(?:0|[1-9][0-9]*)$');
    expect(at(p, 'live')).toEqual({ type: 'boolean' });
    expect(at(p, 'published')).toEqual({ format: 'date-time', type: 'string' });
    expect(at(p, 'day')).toEqual({ format: 'date', type: 'string' });
    expect(at(p, 'hero')).toEqual({
      format: 'uuid',
      type: 'string',
      'x-drefyn-accept': ['image/png'],
    });
    expect(at(p, 'author')).toEqual({ format: 'uuid', type: 'string', 'x-drefyn-to': ['article'] });
    expect(at(p, 'related')).toEqual({
      items: { format: 'uuid', type: 'string' },
      maxItems: 1000,
      type: 'array',
      'x-drefyn-to': ['article'],
    });
    expect(at(p, 'tags')).toEqual({
      items: { type: 'string', 'x-drefyn-max-bytes': 20 },
      maxItems: 5,
      type: 'array',
    });
    expect(at(p, 'meta')).toEqual({
      additionalProperties: false,
      properties: { name: { type: 'string', 'x-drefyn-max-bytes': 64 }, on: { type: 'boolean' } },
      required: ['name'],
      type: 'object',
    });
    expect(at(p, 'legacy', 'deprecated')).toBe(true);
  });

  it('marks required fields in sorted order, and no deprecated one', () => {
    expect(at(doc, 'components', 'schemas', 'content.article.fields', 'required')).toEqual([
      'title',
    ]);
    const deprecatedRequired = schemaOf(
      [
        text(1, { apiName: 'b', required: true }),
        text(2, { apiName: 'a', required: true }),
        text(3, { apiName: 'c', required: true }),
      ],
      {
        deprecated: [fid(3)],
      },
    );
    const other = emitOpenApi([deprecatedRequired], OPTIONS) as unknown as JsonValue;
    expect(at(other, 'components', 'schemas', 'content.article.fields', 'required')).toEqual([
      'a',
      'b',
    ]);
  });

  it('carries the one error body and its codes', () => {
    const error = at(doc, 'components', 'schemas', 'error');
    expect(at(error, 'required')).toEqual(['error']);
    const codes = at(error, 'properties', 'error', 'properties', 'code', 'enum');
    expect(codes).toContain('api.filter_invalid');
    expect(codes).toContain('api.validation_failed');
    expect(codes).toEqual([...(codes as string[])].sort());
  });

  it('refuses a server URL that is not http or https', () => {
    expect(() => emitOpenApi([ARTICLE], { ...OPTIONS, serverUrl: 'javascript:alert(1)' })).toThrow(
      TypeError,
    );
    expect(() => emitOpenApi([ARTICLE], { ...OPTIONS, schemaVersion: -1 })).toThrow(TypeError);
  });

  it('refuses two types with one API name, which would share routes', () => {
    expect(() => emitOpenApi([ARTICLE, { ...AUTHOR, apiName: 'Article' }], OPTIONS)).toThrow(
      TypeError,
    );
  });

  it('emits an empty project', () => {
    expect(at(emitOpenApi([], OPTIONS) as unknown as JsonValue, 'paths')).toEqual({});
  });
});
