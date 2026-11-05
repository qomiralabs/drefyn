# `@drefyn/engine`

The content engine under Docs, Studio and Status. Every piece of content is a typed node, and
customers add types at run time, so one set of tables in `@drefyn/db` holds all of them. This
package owns the closed vocabulary those tables enforce. Read and write functions land here
next.

## Public API

Everything other packages may use is exported from `src/index.ts`. Nothing else in `src/` is
public.

- `NodeFamily`, `NODE_FAMILIES`: the closed set of node families. Studio types are rows, not
  families, so a customer type never changes this list.
- `NodeLifecycle`, `NODE_LIFECYCLES`: the closed set of node lifecycle states.
- `Origin`, `ORIGINS`: where a version came from.
- `EngineErrorCode`, `ENGINE_ERROR_CODES`: the stable error codes engine functions return.

The database refuses a `family`, `lifecycle` or `origin` outside these lists, and a test here
compares each list with the migration, so the two cannot drift.

## Testing

```sh
pnpm --filter @drefyn/engine test
```
