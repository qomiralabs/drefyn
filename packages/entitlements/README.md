# `@drefyn/entitlements`

Maps an organization's tier to its limits and features in Docs, Studio and Status. Every
product reads its limits from here, so a plan change takes effect everywhere at once.
Pure data and functions: no storage, no prices, no network.

## Public API

Everything other packages may use is exported from `src/index.ts`.

- `checkLimit(tier, key, usage, options?)` answers `allowed`, `over_limit` or
  `not_entitled`. `usage` includes the action being checked (the third project, the
  2,001st email). Refusals carry `access: 'read_only'`: over limit content stays and only
  stops being editable.
- `limitFor(tier, key, options?)` and `graceAllowance(tier, key, options?)` return a
  non negative safe integer or `UNLIMITED` (the string `'unlimited'`).
- `hasFeature(tier, feature)`, `limitInfo(key)` and `featureInfo(feature)` read the table.
- `entitlementsFor(product)` returns the same functions with the product name attached, for
  metrics and log context. Every product gets the same answers.
- `TIERS`, `PRODUCTS`, `LIMIT_KEYS`, `FEATURE_KEYS` and `UNCALIBRATED` are frozen lists.
  `UNCALIBRATED` names every cell the plans leave open, the value it resolves to today and
  why (`at_least`, `at_most`, or `unset`, which is 0).

Options:

- `overrides` is an already resolved map of limit key to value, for contract and add on
  raises. A value may only make a limit more generous. The whole map is validated on every
  call and one bad entry fails the call; nothing is partly applied.
- `graceEligible` widens a monthly send cap by `floor(cap * 25 / 100)`. Only the send meter
  or notifier sets it, after deciding the send may use grace.

Bad input (unknown tier, key, feature or product, bad usage, bad overrides) throws an
`EntitlementError` with a stable `code`. Messages never contain the input. Map it to a
server error, never to a free tier or to "allowed".

Every limit counts per organization. Byte limits use decimal gigabytes. The check interval
is a floor, so a smaller override is a raise.

## Testing

```sh
pnpm --filter @drefyn/entitlements test
pnpm --filter @drefyn/entitlements bench
```
