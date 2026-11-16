# `@drefyn/api-gen`

Turns a Studio content schema into what the `/v1` API serves: a validator per type, the
`filter=` decoder, the OpenAPI document, and the GraphQL schema with its limits. It runs at request time, since a schema change
has to be live with no build.

Pure in the plain sense: no I/O, no clock, no randomness, and the same input gives the same
output. It never builds an engine. Whatever reaches the engine takes the process's shared one
as an argument.

## Public API

```ts
const validate = compileValidator(schema);
const result = validate(body); // { ok, value } keyed by field id, or field issues

const filter = parseFilterParam(schema, url.searchParams.get('filter'));

const doc = emitOpenApi(types, { serverUrl, title, schemaVersion });

const schema = graphqlEmitter.emit(types, resolvers);
const result = await runGraphql(schema, body, { tenant }, { introspection });

const cache = createSchemaCache({ maxBytes, sizeOf });
const compiled = await cache.get(schemaCacheKey(tenant, version), build);
```

- `compileValidator(schema)` takes content keyed by API name and returns it keyed by field
  id, in sorted key order, in the form the engine stores. Numbers travel as decimal strings
  only, so a float never gets in. Dates are checked with `canonicalInstant` from
  `@drefyn/schema` and nothing else. Issues carry an API name path and a fixed code, never a
  value the client sent, and stop at 50.
- `parseFilterParam(schema, raw)` reads the JSON filter tree, maps API names to field ids,
  and returns the closed `FilterNode` the engine compiles. Only top level fields can be
  named. A tree past the depth or node limits, text past 16,384 characters, or anything else
  wrong is refused as `api.filter_invalid` with a `filter.*` code and a tree path.
- `emitOpenApi(types, options)` returns an OpenAPI 3.1 document with keys sorted at every
  level, so shuffled types or fields give the same bytes.
- `graphqlEmitter.emit(types, resolvers)` builds a `GraphQLSchema` from `graphql` constructors
  only; no schema text is assembled. Each type gets `get_<name>`, `list_<name>` and the three
  writes, named like the REST operations. Items read as `{ id versionId fields { ... } }`.
  Numbers are `_Decimal` strings at every scale, since `Int` is 32 bits and REST sends strings
  too. Deprecated fields are marked `@deprecated` on output and input. `where` uses one shared
  `_Where` input that decodes through the same path as `filter=`, so equal trees give equal
  `FilterNode`s and equal refusals. Write input goes through `compileValidator`, so field
  codes match REST. References load through a per request batch loader: one call per query
  level, at most 1,000 ids a call and 10,000 a request.
- `runGraphql(schema, request, context, { introspection })` is the only way to run a query.
  Before any resolver runs it refuses: field depth past 8, more than 1,000 items read (a page
  counts its `limit`, a many reference counts 10), more than 50 aliases, more than 10,000
  tokens, and `__schema` or `__type` when introspection is off. Every error carries a stable
  `extensions.code` and fixed text: the REST codes in `CONTENT_ERROR_CODES`, plus
  `api.query_invalid`, `api.query_too_deep`, `api.query_too_complex`,
  `api.introspection_disabled` and `api.internal`.
- `schemaCacheKey(tenant, version)` carries both tenant ids in its prefix.
- `createSchemaCache` keeps compiled schemas under a byte cap with LRU eviction, runs one
  build per key however many callers miss at once, and refuses past `maxInFlight` builds
  with `SchemaCacheBusyError`.
- `parseSchemaCacheConfig(env)` reads `DREFYN_SCHEMA_CACHE_MAX_BYTES`, default 268435456.

## Bench

`pnpm --filter @drefyn/api-gen bench` compiles 50 types of 20 fields, validators and the
serialized OpenAPI document, against a p95 budget of 10 ms. It then emits the GraphQL schema
(p95 under 10 ms), measures heap per cached schema with `--expose-gc` (under 2 MB), and runs a
page query against resolvers that answer at once (p99 under 1 ms). Timings above load 10 are
void; the heap figure always counts.
