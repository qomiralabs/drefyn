import { MAX_LIST_ITEMS, type ContentSchema, type FieldDef, type TypeId } from '@drefyn/schema';
import { z } from 'zod';
import { CONTENT_ERROR_CODES } from './errors.ts';
import { DEFAULT_PAGE, MAX_DEPTH, MAX_PAGE } from './paging.ts';
import type { JsonValue, OpenApiDocument, OpenApiOptions } from './types.ts';

type JsonObject = Record<string, JsonValue>;

const options = z.strictObject({
  serverUrl: z.url({ protocol: /^https?$/ }),
  title: z.string().min(1).max(200),
  schemaVersion: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
});

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Rebuilt with keys in sorted order at every level, so equal documents are equal bytes. Arrays
// keep their order; the emitter sorts the ones whose order means nothing.
function sortedKeys(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort(compareText)) {
    out[key] = sortedKeys((value as JsonObject)[key] as JsonValue);
  }
  return out;
}

const decimalPattern = (scale: number) =>
  scale === 0 ? '^-?(?:0|[1-9][0-9]*)$' : `^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,${String(scale)}})?$`;

const ID: JsonObject = { type: 'string', format: 'uuid' };
const ref = (name: string): JsonObject => ({ $ref: `#/components/schemas/${name}` });

interface Context {
  readonly typeNames: ReadonlyMap<TypeId, string>;
}

function targets(to: readonly TypeId[], context: Context): string[] {
  const names = to.flatMap((id) => {
    const name = context.typeNames.get(id);
    return name === undefined ? [] : [name];
  });
  return [...new Set(names)].sort(compareText);
}

function fieldSchema(field: FieldDef, context: Context): JsonObject {
  switch (field.kind) {
    case 'text': {
      // maxLength in JSON Schema counts characters; the limit here is in UTF-8 bytes.
      const schema: JsonObject = { type: 'string', 'x-drefyn-max-bytes': field.maxLength };
      if (field.format === 'slug') schema['pattern'] = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
      if (field.format === 'email') schema['format'] = 'email';
      if (field.format === 'url') schema['format'] = 'uri';
      return schema;
    }
    case 'markdown':
      return {
        type: 'string',
        contentMediaType: 'text/markdown',
        'x-drefyn-max-bytes': field.maxLength,
      };
    case 'rich_text':
      return ref('richText');
    case 'number': {
      const schema: JsonObject = {
        type: 'string',
        pattern: decimalPattern(field.scale),
        'x-drefyn-scale': field.scale,
      };
      if (field.min !== undefined) schema['x-drefyn-min'] = field.min;
      if (field.max !== undefined) schema['x-drefyn-max'] = field.max;
      return schema;
    }
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
      return { type: 'string', format: field.withTime ? 'date-time' : 'date' };
    case 'asset':
      return { ...ID, 'x-drefyn-accept': [...new Set(field.accept)].sort(compareText) };
    case 'reference': {
      const to = targets(field.to, context);
      return field.many
        ? { type: 'array', items: ID, maxItems: MAX_LIST_ITEMS, 'x-drefyn-to': to }
        : { ...ID, 'x-drefyn-to': to };
    }
    case 'list':
      return { type: 'array', items: fieldSchema(field.of, context), maxItems: field.maxItems };
    case 'object':
      return objectSchema(field.fields, new Set(), context);
  }
}

function objectSchema(
  fields: readonly FieldDef[],
  deprecated: ReadonlySet<string>,
  context: Context,
): JsonObject {
  const properties: JsonObject = {};
  const required: string[] = [];
  for (const field of fields) {
    const schema = fieldSchema(field, context);
    const isDeprecated = deprecated.has(field.id);
    properties[field.apiName] = isDeprecated ? { ...schema, deprecated: true } : schema;
    if (field.required && !isDeprecated) required.push(field.apiName);
  }
  const schema: JsonObject = { type: 'object', additionalProperties: false, properties };
  if (required.length > 0) schema['required'] = required.sort(compareText);
  return schema;
}

const json = (schema: JsonObject): JsonObject => ({
  content: { 'application/json': { schema } },
});

const ERROR_RESPONSE: JsonObject = { $ref: '#/components/responses/error' };

function errors(...statuses: number[]): JsonObject {
  return Object.fromEntries(statuses.map((status) => [String(status), ERROR_RESPONSE]));
}

const pathParam = (name: string): JsonObject => ({
  name,
  in: 'path',
  required: true,
  schema: ID,
});

const query = (name: string, schema: JsonObject, description: string): JsonObject => ({
  name,
  in: 'query',
  required: false,
  description,
  schema,
});

const header = (name: string): JsonObject => ({
  name,
  in: 'header',
  required: true,
  schema: { type: 'string' },
});

// Shared by every type, so each operation carries a reference instead of its own copy.
const PARAMETERS: JsonObject = {
  projectId: pathParam('projectId'),
  id: pathParam('id'),
  cursor: query('cursor', { type: 'string' }, 'Opaque, from the previous page.'),
  depth: query(
    'depth',
    { type: 'integer', minimum: 0, maximum: MAX_DEPTH, default: 1 },
    'How many levels of references to expand.',
  ),
  filter: query(
    'filter',
    { type: 'string', contentMediaType: 'application/json' },
    'A filter tree in JSON, with fields named by API name.',
  ),
  limit: query(
    'limit',
    { type: 'integer', minimum: 1, maximum: MAX_PAGE, default: DEFAULT_PAGE },
    'Items per page.',
  ),
  sort: query('sort', { type: 'string' }, 'A sortable field, by API name.'),
  version: query(
    'version',
    { type: 'string' },
    'Read a pinned version instead of the current one.',
  ),
  idempotencyKey: header('Idempotency-Key'),
  ifMatch: header('If-Match'),
};

const params = (...names: (keyof typeof PARAMETERS)[]): JsonValue[] =>
  names.map((name) => ({ $ref: `#/components/parameters/${name}` }));

function operations(name: string): [string, JsonObject][] {
  const item = ref(`content.${name}`);
  const fields = ref(`content.${name}.fields`);
  const collection: JsonObject = {
    get: {
      operationId: `list_${name}`,
      parameters: params('projectId', 'cursor', 'depth', 'filter', 'limit', 'sort', 'version'),
      responses: {
        '200': { description: 'A page of items.', ...json(ref(`content.${name}.page`)) },
        ...errors(400, 401, 403, 404, 429, 503),
      },
    },
    post: {
      operationId: `create_${name}`,
      parameters: params('projectId', 'idempotencyKey'),
      requestBody: { required: true, ...json(fields) },
      responses: {
        '201': { description: 'Created.', ...json(item) },
        ...errors(401, 403, 404, 409, 413, 422, 429),
      },
    },
  };
  const single: JsonObject = {
    get: {
      operationId: `get_${name}`,
      parameters: params('projectId', 'id', 'depth', 'version'),
      responses: {
        '200': { description: 'The item.', ...json(item) },
        ...errors(401, 403, 404, 429, 503),
      },
    },
    patch: {
      operationId: `update_${name}`,
      parameters: params('projectId', 'id', 'ifMatch'),
      requestBody: { required: true, ...json(fields) },
      responses: {
        '200': { description: 'Updated.', ...json(item) },
        ...errors(401, 403, 404, 409, 413, 422, 429),
      },
    },
    delete: {
      operationId: `delete_${name}`,
      parameters: params('projectId', 'id'),
      responses: { '204': { description: 'Deleted.' }, ...errors(401, 403, 404, 429) },
    },
  };
  const base = `/v1/projects/{projectId}/content/${name}`;
  return [
    [base, collection],
    [`${base}/{id}`, single],
  ];
}

function typeSchemas(type: ContentSchema, context: Context): [string, JsonObject][] {
  const name = type.apiName;
  return [
    [`content.${name}.fields`, objectSchema(type.fields, new Set(type.deprecated), context)],
    [
      `content.${name}`,
      {
        type: 'object',
        additionalProperties: false,
        required: ['fields', 'id', 'versionId'],
        properties: { id: ID, versionId: ID, fields: ref(`content.${name}.fields`) },
      },
    ],
    [
      `content.${name}.page`,
      {
        type: 'object',
        additionalProperties: false,
        required: ['items', 'nextCursor'],
        properties: {
          items: { type: 'array', items: ref(`content.${name}`) },
          nextCursor: { type: ['string', 'null'] },
        },
      },
    ],
  ];
}

const SHARED_SCHEMAS: JsonObject = {
  error: {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', enum: [...CONTENT_ERROR_CODES] },
          message: { type: 'string' },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'path'],
              properties: { code: { type: 'string' }, path: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  // The shared document tree. Its full shape is versioned by astVersion and checked on write.
  richText: {
    type: 'object',
    required: ['astVersion', 'children', 'type'],
    properties: {
      type: { const: 'root' },
      astVersion: { type: 'integer' },
      children: { type: 'array', items: { type: 'object' } },
    },
  },
};

// Same types and options in, same bytes out, whatever order the types and fields arrive in.
export function emitOpenApi(
  types: readonly ContentSchema[],
  opts: OpenApiOptions,
): OpenApiDocument {
  const parsed = options.safeParse(opts);
  if (!parsed.success) throw new TypeError('emitOpenApi: invalid options');
  const sorted = [...types].sort((a, b) => compareText(a.apiName, b.apiName));
  const seen = new Set<string>();
  for (const type of sorted) {
    // Routes are case sensitive but some clients fold case, as the schema rules do for fields.
    const folded = type.apiName.toLowerCase();
    if (seen.has(folded)) throw new TypeError('emitOpenApi: two types share an API name');
    seen.add(folded);
  }
  const context: Context = {
    typeNames: new Map(sorted.map((type) => [type.typeId, type.apiName])),
  };
  const doc: JsonObject = {
    openapi: '3.1.0',
    info: { title: parsed.data.title, version: String(parsed.data.schemaVersion) },
    servers: [{ url: parsed.data.serverUrl }],
    security: [{ apiKey: [] }],
    paths: Object.fromEntries(sorted.flatMap((type) => operations(type.apiName))),
    components: {
      parameters: PARAMETERS,
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer' } },
      responses: {
        error: { description: 'An error, in the one error body.', ...json(ref('error')) },
      },
      schemas: {
        ...SHARED_SCHEMAS,
        ...Object.fromEntries(sorted.flatMap((type) => typeSchemas(type, context))),
      },
    },
  };
  return sortedKeys(doc) as OpenApiDocument;
}
