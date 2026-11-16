# `@drefyn/search`

Public docs search on Typesense, through a proxy. Readers never talk to Typesense: a site host
mounts the route from this package, and the route builds the filter, the collection name and a
short lived scoped key for each search. Only the query text comes from the reader.

Two walls keep one site's search to its own pages. The query builder sends a filter that pins
organization, project, version line, locale and `visibility:=public`. The scoped key embeds the
same filter, built from the tenant alone, and Typesense ANDs the two. A builder that drops or
widens its filter still gets nothing from another site; the integration tests prove it with a
builder that forgets the tenant on purpose. The key also embeds `filter_curated_hits: true` and
`enable_overrides: false`: without them a request can name another tenant's document in
`pinned_hits` and get it back (measured on Typesense 30.2; the attempts are on issue #370).

## Public API

Everything other packages may use is exported from `src/index.ts`.

- `createSearchRoute({ sites, search, limiter, logger })` returns
  `(request: Request, clientIp: string) => Promise<Response>` for `GET /api/search?q=&version=&locale=`
  on a site host. The host resolves the client address from its socket and trusted proxies, and
  `sites.resolve(host)` maps a verified host to a `TenantRef` or null.
  - 200 `{ hits: [{ nodeId, path, title, excerpt: [{ text, match }] }] }`, at most 20 hits,
    `Cache-Control: no-store`. Render the excerpt as text, never as HTML.
  - 400 `search.query_invalid`: missing or repeated `q`, more than 256 bytes, or a bad version or
    locale.
  - 404 `search.not_found`: the host is no site.
  - 405 `search.method_not_allowed`.
  - 429 `search.rate_limited` with `Retry-After`: 30 a minute per client and site by default.
  - 503 `search.unavailable`: Typesense, the site lookup or the limiter failed. Pages never wait
    on search, so the site still renders.
- `createPublishedSearch({ client, searchKey })` runs one search for a `TenantRef` and a
  `SearchPin`. `searchKey` is the parent key: search only, public site collections only. It never
  leaves the process.
- `createSearchIndexer({ client, adminKey })` writes published pages: `ensureSite`, `indexPages`
  (upsert, at most 500 pages a call), `removePages` and `dropSite`. Tenant fields on every
  document come from the `TenantRef` and the pin, never from the page.
- `ensurePublicSearchKey(client, adminKey, value)` creates the parent key; safe to run at every
  start.
- `createTypesenseClient({ url })`: 2 s deadline, no redirects, a 1 MiB cap on answers, and one
  jittered retry for idempotent calls only.
- `createMemoryRateLimiter()` and the `RateLimiter` port. The memory limiter counts per process;
  a host with several processes plugs in a shared store.
- `parseSearchQuery`, `parseSearchPin`, `publishedFilter`, `publicCollectionFor`,
  `generateScopedKey` for hosts and tests.

One public collection per site, `docs_pub_<project id without hyphens>`, with `version_key` and
`locale` on every document. Protected pages never go in it.

## Logs

One `search.request` line per request with public organization and project ids, the pin, the
status, the hit count and timings. Never the query text, an excerpt, a key, the host or an
address. Typesense failures log a reason code only.

## Tests

`pnpm test` runs the unit and property tests. `pnpm test:integration` needs the compose stack
with the search profile:

```sh
COMPOSE_PROFILES=search bash scripts/selfhost.sh up
pnpm --filter @drefyn/search test:integration
```

It reads the admin key from `deploy/.env`, or `DREFYN_SEARCH_ADMIN_KEY` and `DREFYN_TYPESENSE_URL`
from the environment.

## Self hosting

Typesense is the only service search needs, and it runs in the compose stack under the `search`
profile with nothing paid. Its server is GPL-3.0 and runs as a separate process reached over
HTTP; this package is Apache-2.0 and links none of it.
