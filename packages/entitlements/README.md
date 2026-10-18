# `@drefyn/entitlements`

Maps an organization's tier to its limits and features in Docs, Studio and Status. Every
product reads its limits from here, so a plan change takes effect everywhere at once.
Pure data and functions: no storage, no prices, no network.

## Public API

Everything other packages may use is exported from `src/index.ts`. The API is being
written test first; this section lists the exports once they land.

## Testing

```sh
pnpm --filter @drefyn/entitlements test
```
