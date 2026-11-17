# `@drefyn/github`

The GitHub App, held in one place. The App's private key can mint a token for every
repository of every customer who installed it, so this package is the only code that reads
the key, and every token it hands out is narrowed to one repository and the least permission
the job needs. It also checks webhook deliveries before anything reads them.

Open core: a self hosted install registers its own App and points this package at
api.github.com or its GitHub Enterprise Server. Nothing here calls a Drefyn hosted service.

## Public API

Everything other packages may use is exported from `src/index.ts`. The key reader,
`src/private-key.ts`, is not exported, and the boundary guard refuses any import of it from
another package.

### Broker

```ts
const broker = createGitHubBroker({
  config: parseGitHubAppConfig(process.env),
  installations: createInstallationStore({ db }),
  flags, // the @drefyn/flags client
  logger,
});

const result = await broker.withInstallationToken(
  { tenant, installationId, repositoryId, permissions: { contents: 'read' }, purpose: 'sync' },
  async (token) => readTree(token.authorization()),
);
```

- `mintInstallationToken(request, signal?)` returns a `ShortLivedToken` or a `BrokerError`.
  `withInstallationToken(request, work, signal?)` mints, lends the token to `work`, then
  revokes it with GitHub and forgets it, whether `work` finished or threw.
- A request names one repository and one of three permission sets, matched to its purpose:
  `import` and `sync` take `{ contents: 'read' }`; `commit` takes `{ contents: 'write' }` or
  `{ contents: 'write', pull_requests: 'write' }`.
- In order, before GitHub is called: the request shape (`github.request_invalid`), the
  permission for the purpose (`github.permission_too_wide`), the `docs.git_sync` flag for the
  tenant (`github.disabled`; a flag that cannot be read refuses), the installation record for
  the project (`github.installation_not_owned`, `github.suspended`) and the repository in that
  record (`github.repository_not_selected`).
- GitHub is asked for `repository_ids: [repositoryId]` and the permission set. A token whose
  answer is wider than asked (more repositories, all repositories, or more permission than
  asked plus `metadata: read`) is revoked at once and refused with `github.token_too_wide`.
- GitHub's answers map to `github.installation_not_owned` (404), `github.suspended` (403),
  `github.rate_limited` (429, or 403 with no rate left; `retryAfterSeconds` when GitHub says)
  and `github.repository_not_selected` (422). A refused App key (401), a server error, a
  network failure or a reply that is not a token is `github.unavailable`.
- A token's value is in a private field: JSON, `String()` and `util.inspect` never show it.
  `authorization()` throws once the token is disposed or expired.

### Webhooks

```ts
const receiver = createWebhookReceiver({
  secret: readWebhookSecret(file),
  ledger: createDeliveryLedger({ db }),
  onDelivery, // optional: what to do with a verified delivery
  logger,
});
const outcome = await receiver.receive({ body, signature, deliveryId, event });
```

In order: a body over 5 MiB is 413 `github.too_large`; a missing, malformed or wrong
`X-Hub-Signature-256` is 401 `github.signature_invalid` (HMAC SHA-256 over the raw bytes,
compared with `timingSafeEqual`); a delivery id that is not a GUID or a bad event name is 400
`github.delivery_invalid`; a body that is not a JSON object, or carries an installation or
repository id that is not a positive integer, is 400 `github.payload_invalid`. A delivery id
or a body taken before is 409 `github.delivery_replayed`, so a captured body and signature
sent again under a fresh delivery id is refused too. If `onDelivery` throws, the delivery is
released so GitHub's redelivery is taken, and the answer is 503 `github.unavailable`.

`verifyGitHubWebhook(rawBody, signature256, secret)` is the check on its own.

### Stores

- `createInstallationStore({ db })`: `record`, `get`, `setSuspended` and `remove` on
  `app.github_installations`, each under the project's tenant context. A row names the
  installation, its account and up to 100 repositories the project may ask tokens for.
- `createDeliveryLedger({ db })`: `claim` and `release` on `app.github_webhook_deliveries`
  through `withWebhookLedger`, the empty context. Deliveries arrive before any tenant is
  known, so the table holds delivery ids, body digests and event names only. Each claim ages
  out at most 100 rows older than 30 days.

## Settings

| Key                                 | Meaning                                          | Default                  |
| ----------------------------------- | ------------------------------------------------ | ------------------------ |
| `DREFYN_GITHUB_APP_ID`              | The App's numeric id                             | required for the broker  |
| `DREFYN_GITHUB_PRIVATE_KEY_FILE`    | Absolute path of the App's PEM key, RSA 2048+    | required for the broker  |
| `DREFYN_GITHUB_WEBHOOK_SECRET_FILE` | Absolute path of the webhook secret, 16+ bytes   | unset: no webhook route  |
| `DREFYN_GITHUB_API_URL`             | https API base; Enterprise Server keeps its path | `https://api.github.com` |
| `DREFYN_GITHUB_ALLOW_PRIVATE_CIDRS` | Comma separated ranges, self hosted GHES only    | none                     |
| `DREFYN_GITHUB_CALL_TIMEOUT_MS`     | One GitHub call, 1000 to 60000                   | `15000`                  |

Secrets are read from files, never from env values. A bad value stops the start with a
`GitHubConfigError` naming the key and never the value.

## Network

Every call goes through `@drefyn/egress` with the `github` purpose: https only, no redirect,
the port of the configured API only, the call timeout above, and 64 KiB for token calls. A
private address is refused unless the operator lists its range. Both calls the broker makes
are safe to repeat, so a network failure or a 500, 502, 503 or 504 is tried three times at
most, waiting a random time up to 200 ms, then up to 400 ms.

## Logs

`github.token_minted`, `github.token_refused`, `github.token_revoke_failed` and
`github.flag_read_failed` carry the organization and project ids, the installation and
repository ids, the purpose and a code. `github.webhook_accepted`, `github.webhook_refused`
and `github.webhook_failed` carry the delivery id and event name when they are well formed,
and the installation and repository ids once the signature is proved. Never a token, a JWT,
the key, the secret, a signature or a body.

## Tests

- `pnpm --filter @drefyn/github test`: unit and property tests, 95 percent of lines and
  branches. The broker runs through the real egress guard against a fake GitHub on loopback
  over TLS, with a key pair made for the run; nothing calls the real API.
- `pnpm --filter @drefyn/github test:integration`: the stores and row level security against
  the compose Postgres, with `COMPOSE_PROJECT_NAME` set; 95 percent of lines of both stores.
