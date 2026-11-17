# @drefyn/api

The `/v1` service: one Node process on Hono that checks API keys and serves retrieval over
published docs; content and probe ingest come later. It holds `drefyn_app` and `drefyn_public_reader`, and never the auth
role or an auth secret.

## Run

```sh
node apps/api/server.ts
```

Or with the self host stack: `COMPOSE_PROFILES=api bash scripts/selfhost.sh up`.

## Settings

| Key                                 | Meaning                                                    | Default                  |
| ----------------------------------- | ---------------------------------------------------------- | ------------------------ |
| `DREFYN_API_PORT`                   | Listening port                                             | `3100`                   |
| `DREFYN_API_HOST`                   | Listening address                                          | `127.0.0.1`              |
| `DREFYN_API_PUBLIC_URL`             | Origin clients call, written into `openapi.json`           | required in production   |
| `DREFYN_API_MAX_BODY_BYTES`         | Largest request body, 1 to 67108864                        | `1048576`                |
| `DREFYN_API_RATE_LIMIT_KEY`         | HMAC key for the key failure limiter                       | required                 |
| `DREFYN_AUTH_RATE_API_KEY_FAIL`     | Failed checks allowed per client                           | `60/1m`                  |
| `DREFYN_DATABASE_URL`               | `drefyn_app` connection                                    | required                 |
| `DREFYN_PUBLIC_READER_DATABASE_URL` | `drefyn_public_reader` connection                          | required                 |
| `DREFYN_TRUSTED_PROXY_HOPS`         | Proxies in front; 0 reads the socket                       | `0`                      |
| `DREFYN_CLIENT_IP_HEADER`           | `cloudfront-viewer-address` from the trusted hop, or unset | unset                    |
| `DREFYN_FLAGS_*`                    | Flag source, as in `@drefyn/flags`                         | `/etc/drefyn/flags.json` |
| `DREFYN_RETRIEVAL_*`                | Retrieval caps and timeouts, as in `@drefyn/retrieval`     | see that README          |

It exits 1 with one `api.start_failed` line naming the key when a setting is wrong, and when
`DREFYN_AUTH_DATABASE_URL` or any auth secret is set.

## Routes

- `GET /healthz`: 200 while the process is up. Touches no database.
- `GET /readyz`: 200 when both pools answer within a second, else 503 `api.unavailable`.

Every `/v1/projects/:projectId/...` route sits behind
`guard(deps, { scope, flag?, entitled?, limit? })`, which runs, in order: client address through
the trusted hops, the key (a key in the query string is refused), the scope, the project under
the key's organization (another organization's project is 404, as is one that does not exist),
the key's project list, the release flag (off is 404), the plan feature (403, or 503 when the
plan cannot be read), the plan limit, then the handler. Handlers read the proved tenant with
`tenantOf(c)`. A refused scope or project counts against the client in the same failure
limiter as a bad key.

### `GET /v1/projects/:projectId/retrieve`

Ranked passages from a docs project's published, public pages, through `@drefyn/retrieval`.
Protected pages, drafts and replaced versions are never returned. Any word matches, ranked by
relevance; a question with no words has no hits.

- Key scope `docs:pages.read` (the same scope MCP reads with), on a docs project.
- Release flag `retrieval.v1`, off in production. Plan feature `docs.retrieval_api` (Growth and
  up, and every self host).
- Parameters: `query` (required, 1 to 512 characters after trimming), `version` (default
  `latest`, the only label today) and `limit` (1 to 20, default 8). A repeated or unknown
  parameter is 400.
- Answers JSON with `cache-control: no-store`: a `pin` (`version`, `publishedAt`), the
  `ranking` and the `hits`, each with `chunkId`, `nodeId`, `versionId`, `path`, `title`,
  `headingPath`, `text` and `rank`. Text is reader text, never HTML. Ranks, never scores.
- Bounded by the library: at most `DREFYN_RETRIEVAL_MAX_IN_FLIGHT` reads per organization per
  process, each under `DREFYN_RETRIEVAL_TIMEOUT_MS`; past either the answer is 503
  `retrieval.busy`.

The document clients read is [`openapi/v1.json`](openapi/v1.json), written from the code by
`pnpm --filter @drefyn/api openapi`. `pnpm --filter @drefyn/api test:contract` fails when the
committed copy and the route disagree.

## Errors

One body: `{ "error": { "code": "...", "message": "..." } }`, with `cache-control: no-store`
and `Retry-After` on 429 and 503.

| Status | Code                          | When                                       |
| ------ | ----------------------------- | ------------------------------------------ |
| 400    | `retrieval.bad_input`         | A retrieval parameter is not valid         |
| 401    | `auth.api_key_invalid`        | No key, a bad key, or a key in the query   |
| 403    | `auth.api_key_scope`          | The key lacks the scope or the project     |
| 403    | `api.not_entitled`            | The plan lacks the route's feature         |
| 404    | `api.not_found`               | No such route or project, or flag off      |
| 404    | `retrieval.version_not_found` | No such published version                  |
| 413    | `api.too_large`               | Body over `DREFYN_API_MAX_BODY_BYTES`      |
| 429    | `auth.rate_limited`           | Too many failed checks from one client     |
| 429    | `api.limit_reached`           | The plan limit for the request             |
| 503    | `auth.unavailable`            | Keys cannot be checked                     |
| 503    | `api.unavailable`             | A pool is down, or the plan cannot be read |
| 503    | `retrieval.busy`              | Retrieval timed out or is at its cap       |
| 503    | `retrieval.unavailable`       | Retrieval cannot reach its database        |
| 500    | `api.internal`                | Anything else                              |

## Scopes

`studio:content.read`, `studio:content.read_drafts` and `studio:content.write`, each granted by
`studio.read`, and `docs:pages.read`, granted by `docs.read`.

## Logs

One JSON line per event on stderr. Request lines carry the method, route pattern, status,
duration, request id and, once proved, the organization, project and key ids. Never a body, a
header, a query string, a key or an address. Passing health probes are not logged. Retrieval
adds its own `retrieval.request` line with ids, counts and latency, never the question.

## Tests

```sh
pnpm --filter @drefyn/api test               # unit, 95 percent lines
pnpm --filter @drefyn/api test:contract      # responses against openapi/v1.json
pnpm --filter @drefyn/api test:integration   # needs the compose stack and COMPOSE_PROJECT_NAME
```
