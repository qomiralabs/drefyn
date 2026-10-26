# `@drefyn/flags`

Server side feature flags for every Drefyn app. Release flags keep unreleased features off,
kill switches stop a feature without a deploy, plan flags read the organization's tier
through `@drefyn/entitlements`, and experiments carry a written success metric. Flags are
evaluated through the OpenFeature Node server SDK with the flagd provider, in process only.
No provider failure turns a release flag on or leaves a request waiting.

## Public API

Everything other packages may use is exported from `src/index.ts`, plus the test helpers in
`@drefyn/flags/testing`. Nothing else in `src/` is public.

### Definitions

- `defineFlags(definitions)` validates a registry at module load and returns it frozen. It
  throws a `FlagError` with code `FLAG_DEFINITION_INVALID`, the `flag` name and a `problem`:
  `name_pattern` (not `<area>.<feature>`, lower snake case after the dot), `unknown_area`,
  `unknown_kind`, `owner_missing`, `date_invalid` (not a real `YYYY-MM-DD` day),
  `remove_by_missing` or `remove_by_not_after_created` (release and experiment flags),
  `duplicate_name`, `metric_missing` (experiments), `safe_value_invalid`, `feature_unknown`
  (plan flags).
- `FlagKind`: `release`, `plan`, `kill_switch`, `experiment`. `FLAG_KINDS` and `FLAG_AREAS`
  are frozen lists.
- `ReleaseFlag` and `ExperimentFlag` have `safeValue: false` by type. `KillSwitch` must
  declare `safeValue`; it is named for what it keeps running, so on means running and off
  means stopped. `PlanFlag` names an entitlements `feature`.
- `flags` is the package registry: `product.docs`, `product.studio` and `product.status`,
  all release flags. `FlagName` is the union of their names, so an unregistered name fails
  typecheck.

### Client

```ts
const client = await createFlagClient(loadFlagConfig(process.env), {
  entitlements, // { hasFeature(organizationId, feature): Promise<boolean> }
  logger, // optional { warn(event, fields) }
  metrics, // optional { gauge(name, value, labels), histogram(name, value, labels) }
});
await client.isOn('product.docs', { organizationId });
await client.evaluate('product.docs', { organizationId, projectId, internal: true });
await client.close();
```

- `createFlagClient(config, deps)` builds one flagd provider in process: offline file mode
  for source `file`, in process sync for source `flagd`. There is no RPC option. Every
  provider option is set explicitly, so the provider's own `FLAGD_*` variables cannot change
  the resolver, the file, the host, the selector or anything else. It never throws when the
  provider is unreachable: it waits at most the init timeout, logs
  `flags.provider_not_ready` and, until the provider first syncs, answers safe values with
  `FLAG_PROVIDER_NOT_READY` without calling it. An invalid config rejects with
  `FLAG_CONFIG_INVALID`. `deps.registry` replaces the package registry, for tests.
- `close()` stops the provider. The flagd provider is patched (see
  `scripts/patches/@openfeature__flagd-provider@0.17.0.patch`) so that its gRPC sync stops
  reconnecting once closed; without it a closed client kept retrying and held the process
  open.
- The provider sees exactly the caller's context and nothing else: `targetingKey` and
  `organizationId` from `organizationId`, `projectId` and `userId` when given, and
  `internal`, false unless the caller says true. The global and transaction OpenFeature
  contexts are not merged in, and the context is frozen.
- Evaluations call the client's own provider directly, not an OpenFeature client, so no
  OpenFeature hook runs on them. See Hooks below.
- `isOn(name, ctx)` returns a boolean. Plan flags are left out by type.
- `evaluate(name, ctx)` returns `{ value, source, errorCode? }`. `source` is `provider`,
  `safe_value`, `test_override` or `entitlements`. `errorCode` is `FLAG_TIMEOUT`,
  `FLAG_PROVIDER_NOT_READY`, `FLAG_NOT_FOUND`, `FLAG_PARSE_ERROR` (including a provider value
  that is not a boolean) or `FLAG_GENERAL`.
- Every provider evaluation passes the definition's `safeValue` as the OpenFeature default,
  and each call is wrapped in its own timeout. On any error, timeout or wrong type the
  result is the `safeValue` with source `safe_value`. After the provider loses its
  connection, the in process provider keeps serving its last synced values, and so does
  the client.
- Plan flags call `entitlements.hasFeature(organizationId, feature)` and never the provider.
  If that call fails, hangs or answers something other than a boolean, the flag is off.
- The context's `organizationId` is the OpenFeature targeting key.
- A name outside the registry evaluates off with `FLAG_NOT_FOUND`.
- A provider that reports itself failed for good (`PROVIDER_FATAL`) maps to
  `FLAG_PROVIDER_NOT_READY`. After `close()`, every call answers its safe value (plan flags
  off) without reaching the provider or entitlements.
- Plan flag lookups share the evaluation timeout, so the reader should answer from a cached
  tier rather than a fresh database read.

### Hooks

OpenFeature hooks are process wide: any code that imports the SDK can call
`OpenFeature.addHooks`, and a provider can carry its own (flagd adds one in sync mode that
merges the sync stream's context). In `@openfeature/server-sdk` 1.23.0, before hooks run
API, client, call, then provider hooks, and each can return or write context keys; after,
error and finally hooks run in reverse, so API hooks run last there, and they share the
result object. A hook could therefore set `internal`, move `targetingKey` and
`organizationId` to another organization (and with them a fractional rollout), add keys a
targeting rule reads, or rewrite the value after the provider answered. A call level hook
that re-applies the pinned fields closes only the first of those, and runs before the
provider hook.

So the client skips the OpenFeature evaluation API and calls its provider's resolver with
the caller's frozen context, after the same not ready and fatal checks the SDK makes. Hooks
anywhere in the process have no effect on these evaluations, a hook that throws included.
What that gives up:

- Hooks added for telemetry or logging do not see flag evaluations. Use
  `flags_evaluation_ms` and the client's own logs instead.
- The flagd sync context is not merged into the evaluation context. Targeting rules must
  read only the fields above.
- Log lines from the provider during an evaluation are dropped, since they are free text
  that can carry context values. Failures still show in the result's `errorCode` and in
  the histogram labels.

The provider's events still arrive through the OpenFeature client. The test client from
`@drefyn/flags/testing` already reads its in memory provider directly, so hooks do not
reach it either.

### Config

`loadFlagConfig(env)` reads these keys. An empty value counts as unset. Any invalid value,
for any key, throws `FLAG_CONFIG_INVALID` with the `key`; the message never contains the
value.

| Key                            | Meaning                                       | Default                  |
| ------------------------------ | --------------------------------------------- | ------------------------ |
| `DREFYN_FLAGS_SOURCE`          | `file` or `flagd`                             | `file`                   |
| `DREFYN_FLAGS_FILE`            | flagd JSON read when the source is `file`     | `/etc/drefyn/flags.json` |
| `DREFYN_FLAGD_HOST`            | flagd host, required when the source is flagd | none                     |
| `DREFYN_FLAGD_SYNC_PORT`       | flagd sync port, 1 to 65535                   | `8015`                   |
| `DREFYN_FLAGS_EVAL_TIMEOUT_MS` | per evaluation timeout, positive integer      | `50`                     |
| `DREFYN_FLAGS_INIT_TIMEOUT_MS` | wait for the provider at start, integer, 0 up | `2000`                   |

The production client ignores `DREFYN_RELEASE_FLAGS`.

### Metrics and logs

Emitted through the injected sink:

- `flags_provider_ready` (gauge): 1 while the provider is in sync, 0 before it first syncs
  and after it reports stale or error.
- `flags_last_sync_age_seconds` (gauge): 0 while in sync; otherwise seconds since sync was
  lost, or since the client started if the provider never synced. Both gauges are pushed on
  every change of sync state and every 15 seconds while the client is open, so the age
  keeps rising in a push sink; alert on it at 5 minutes. In file mode the provider reports
  no loss once the file has been read: if the file later becomes unreadable it keeps the
  last values and the age stays 0. A file that is missing at start counts from client start.
- `flags_evaluation_ms` (histogram): one per evaluation, labelled with the flag name (or
  `unregistered`), the `source` and the `error` code when there is one.

Gauges carry only the `source` label (`file` or `flagd`). Metric labels never carry
organization, project or user IDs, and logs never carry user IDs. The one log event is
`flags.provider_not_ready`, logged once when the provider is not ready at the end of the
init wait, with the source, the reason (`timeout` or `failed`, decided by how the start
ended, not by errors reported during it) and the time waited. A sink
that throws is ignored.

### Test helpers: `@drefyn/flags/testing`

- `releaseFlagsFromEnv(env?, registry?)` reads `DREFYN_RELEASE_FLAGS`: `on` turns every
  release flag on, `off` turns every one off, unset gives the production defaults. Kill
  switches and experiments are the same in all three, and plan flags are left out. Any
  other value throws `FLAG_CONFIG_INVALID`. Returns an OpenFeature in memory configuration.
- `createTestFlagClient(overrides?, { env?, registry? })` returns a client over that
  configuration with `overrides` applied on top (source `test_override`). It has no
  entitlements, so a plan flag without an override is off. An override for a name outside
  the registry, or one that is not a boolean, throws `FLAG_DEFINITION_INVALID` naming it.

Production code never imports this entry point; a test checks every file under `src/`.

## Testing

```sh
pnpm --filter @drefyn/flags test
pnpm --filter @drefyn/flags typecheck
pnpm --filter @drefyn/flags bench
```

CI runs the suite with `DREFYN_RELEASE_FLAGS=on` and `off`. The bench times warm
evaluations through the real provider in offline file mode; the budget is p99 under 1 ms
per call.
