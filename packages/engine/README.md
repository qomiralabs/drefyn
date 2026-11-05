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
- `NodeContent`: what a version stores. Docs pages and rich text are an `MdxRoot` from
  `@drefyn/mdx`, kept as it is.
- `astVersionOf(content)`: the value for `node_versions.ast_version`. It comes from the tree, so
  the column cannot say something the content does not.

The database refuses a `family`, `lifecycle` or `origin` outside these lists, and a test here
compares each list with the migration, so the two cannot drift.

## Testing

```sh
pnpm --filter @drefyn/engine test
COMPOSE_PROJECT_NAME=<stack> pnpm --filter @drefyn/engine test:integration
```

Integration files end in `.integration.test.ts` and need a stack from `scripts/selfhost.sh up`.
They skip with the reason on a machine without one, and fail in CI.
