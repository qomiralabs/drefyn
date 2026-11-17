# `@drefyn/retrieval`

One read path over published docs for agents and the reader assistant. The `/v1` retrieval
routes and the MCP server are thin adapters over this package, so they cannot drift from it.
Every answer is pinned to a version and reads only published, public text: the library runs
as the public reader role, which has no grant on any draft table, and the restrictive policy on
`published_chunks` hides protected pages from it whatever the query asks.

Behind the `retrieval.v1` release flag, off in production.

## Public API

Everything other packages may use is exported from `src/index.ts`.

- `createRetrieval({ reader, config, flags, logger?, metrics? })`, with
  `reader: publishedReader(db)` over a `PublishedDatabase`.
  - `retrieve(tenant, { query, version?, limit?, pathPrefix? })`: hits with chunk id, node id,
    published version id, page path, title, heading path, reader text and a 1 based rank. No
    scores, so ranking can change without breaking a client. `ranking` is `lexical`.
  - `retrieveScored(tenant, input)`: the same hits plus `coverage`, for the assistant's gate
    only. Never put it on a route or an MCP tool.
  - `getPage(tenant, { path or nodeId, version? })`: the page's current sections in order.
  - `listVersions(tenant)`: `latest`, until named docs versions exist.
- `createTermRebuild({ store: appTermStore(db) })`: `rebuildTermStats(tenant)` recomputes the
  three term tables for one project from its public current chunks, in one transaction that
  queues on the publish writer's lock. Idempotent. It holds the app role, so it is a separate
  object: a read path never needs that handle.
- `parseRetrievalConfig(env)` reads the keys below once at boot and throws
  `RetrievalConfigError` (`code: 'config.invalid'`, `key`) on a bad value.

Errors are values: `{ ok: false, error }` with one of `retrieval.bad_input`,
`retrieval.version_not_found`, `retrieval.not_found`, `retrieval.busy` (statement timeout or the
organization's in flight limit; retry) and `retrieval.unavailable` (the database or the flag
source is down). A protected page, a draft, another project's page and a missing page are all
`retrieval.not_found`. With the flag off every call is `retrieval.not_found`, so an adapter
answers as if the feature did not exist; a flag that cannot be read fails closed as
`retrieval.unavailable`.

## How a question is answered

One statement, in a read only transaction with the tenant set locally, then
`plan_cache_mode = force_custom_plan` and the statement timeout set locally:

1. The question's lexemes are the distinct lexemes of `to_tsvector('simple', query)`, first
   `DREFYN_RETRIEVAL_MAX_QUERY_TERMS` in question order. No tsquery is parsed from input, so
   there is no syntax to get wrong. Any word matches; a question with no lexemes has no hits.
2. Each lexeme's document frequency and the project's chunk count and total length come from
   the term tables publish keeps.
3. Lexemes in at most `DREFYN_RETRIEVAL_COMMON_TERM_PERCENT` of chunks pick candidates, rarest
   first, while their postings fit `DREFYN_RETRIEVAL_MAX_POSTINGS`; postings are read highest
   term frequency first. If none qualifies, the rarest lexeme picks alone.
4. The best `DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES` candidates by partial score get every other
   lexeme's term by a primary key probe.
5. BM25 with k1 1.2 and b 0.75 (constants in code) ranks them; ties go to the chunk id.

Postings reads are index only scans on the covering postings indexes, so work is bounded by
the caps rather than by project size.

## Config

| Key                                         | Default | Range                                   |
| ------------------------------------------- | ------- | --------------------------------------- |
| `DREFYN_RETRIEVAL_MAX_QUERY_TERMS`          | 32      | 1 or more                               |
| `DREFYN_RETRIEVAL_COMMON_TERM_PERCENT`      | 50      | 1 to 100                                |
| `DREFYN_RETRIEVAL_MAX_POSTINGS`             | 20000   | 1 or more                               |
| `DREFYN_RETRIEVAL_MAX_SCORED_CANDIDATES`    | 1000    | 1 to `MAX_POSTINGS`                     |
| `DREFYN_RETRIEVAL_SEARCH_ENGINE_MIN_CHUNKS` | 25000   | 0 or more; 0 never reports              |
| `DREFYN_RETRIEVAL_TIMEOUT_MS`               | 1500    | 1 to 10000                              |
| `DREFYN_RETRIEVAL_MAX_IN_FLIGHT`            | 8       | 1 to 1000, per organization per process |

A project above `SEARCH_ENGINE_MIN_CHUNKS` public current chunks still answers on Postgres and
logs `retrieval.over_engine_threshold` with ids and the chunk count. Changing any of the first
five reruns the recall eval and the bench.

## Logs and metrics

`retrieval.request` once per call: ids, op, outcome, latency, and for searches the lexeme,
candidate, postings and hit counts. `retrieval.read_failed` and `retrieval.flag_read_failed`
on failures. `retrieval_latency_ms` by op, outcome and project size bucket. Never the
question, its lexemes, a path or any chunk text.

## Tests, eval and bench

- `pnpm --filter @drefyn/retrieval test`: unit tests, 95 percent lines.
- `pnpm --filter @drefyn/retrieval test:integration`: against the compose stack
  (`COMPOSE_PROJECT_NAME` set): BM25 against a hand computed fixture and a TypeScript reference
  over postings recomputed from text, every cap at, under and over its limit, versions, isolation
  across two organizations, the plan, the rebuild and failures.
- `pnpm --filter @drefyn/retrieval eval:recall -- --set <dir>`: recall at 8 and the gate on
  the #637 question set, read by path and never committed.
- `pnpm --filter @drefyn/retrieval bench -- [--sizes 11210,25000] [--set <dir>]`: refusal
  latency, one client, 10 other projects present. 11,210 is gated at p95 under 200 ms. Pin the
  Postgres container to 2 CPUs and 1 GB and run on a quiet host; it will not start at a load
  average of 8 or more.
