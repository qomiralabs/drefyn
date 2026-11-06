# `@drefyn/engine`

The content engine under Docs, Studio and Status. Every piece of content is a typed node, and
customers add types at run time, so one set of tables in `@drefyn/db` holds all of them. This
package owns the closed vocabulary those tables enforce and the one path every write takes.

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

- `createEngine(deps)`: the five calls below, over a store, a parse client, flags and a policy.
  `databaseStore(db)` makes the store from a `@drefyn/db` database.
- `parseEngineConfig(env)`: reads the caps below.
- `chunkNode(content, options)`: splits a tree into block aligned chunks. Pure: the same content
  and options give the same chunks in the same order, and their bodies join back into the page.

The database refuses a `family`, `lifecycle` or `origin` outside these lists, and a test here
compares each list with the migration, so the two cannot drift.

## Writing content

| Call           | Does                                                                             |
| -------------- | -------------------------------------------------------------------------------- |
| `createNode`   | Adds a node with no version. Its id always comes from the database.              |
| `saveDraft`    | Adds a version when `expectedHeadVersionId` is still the head.                   |
| `rollback`     | Adds a version with an older version's content, and keeps that version's origin. |
| `getHead`      | Reads the head, content included.                                                |
| `listVersions` | Lists versions newest first, without content.                                    |

Every call returns a `Result`, and only a bug throws. `engine.not_found` covers another tenant's
ids as well, so a caller cannot tell them apart. `engine.unavailable` is the one retryable code:
the database or parse host is down or full, and nothing was stored. Writes need the `engine.writes`
flag, off in production, and are `engine.forbidden` without it. Reads never need it.

A save re-reads its input before it trusts it:

1. `validateTree` from `@drefyn/mdx` applies closed key sets per node type, a known `astVersion`,
   and depth, node and byte limits, with its own stack. NUL and lone surrogates are refused, since
   jsonb holds neither and encoding them would break byte fidelity.
2. The parse host prints the tree and parses what it printed, and refuses when those bytes do not
   mean what the nodes say. A hash in a submitted tree proves nothing, as it has no key.
3. The host's tree gets the same check as a client's.
4. The stored tree is the host's, capped by size, never the one sent.

Each tree check runs before anything recursive. The transaction runs last and holds the node's
row lock, so saves to a node queue and sequence numbers have no gaps. A retry with the same
`idempotencyKey` and the same input gets the first version, even after the head moved or the
organization went read only. The same key with anything else is `engine.idempotency_conflict`.

`node_versions` is append only: `drefyn_app` holds select and insert on it and nothing more. Limits
come from `@drefyn/entitlements` and count per organization in `organization_node_counts`, updated
in the transaction that creates the node. A read only organization or project, or one over its
limit after a downgrade, gets `engine.read_only` on writes, and reads go on working.

## Chunks

With `engine.chunk_at_write` on, off in production, a save or rollback writes the version's chunks
and one `embed_chunks` row in `engine_outbox` in the version's own transaction, so a version never
commits without them. Embedding runs later and never in this path. A replay writes nothing, and a
page with no text gets no outbox row. Chunks belong to a version and are not replaced by the next.

A chunk is made of whole blocks and starts again at every heading, so a word edited in one section
cannot move text in another. It closes before it passes the target. A block over the target splits
at line ends, and a line over the cap is cut at the cap. `chunkNode` runs before the transaction
on a save, and under the lock on a rollback, where a replay must not pay for it.

## Configuration

| Key                            | Default | Meaning                                               |
| ------------------------------ | ------- | ----------------------------------------------------- |
| `DREFYN_ENGINE_MAX_NODE_BYTES` | 1048576 | Source bytes of one node. Can only be lowered.        |
| `DREFYN_ENGINE_MAX_TREE_BYTES` | 5242880 | Stored JSON of one version, at most 16777216.         |
| `DREFYN_CHUNK_TARGET_CHARS`    | 800     | Close a chunk before it passes this. At most the cap. |
| `DREFYN_CHUNK_MAX_CHARS`       | 2000    | Hard cap on a chunk, whatever the page holds.         |

A tree is about 4 times its source at the corpus median and 7.5 times at worst, so a source cap
alone allows far larger rows. Both limits answer `engine.too_large`.

## Testing

```sh
pnpm --filter @drefyn/engine test
COMPOSE_PROJECT_NAME=<stack> pnpm --filter @drefyn/engine test:integration
COMPOSE_PROJECT_NAME=<stack> pnpm --filter @drefyn/engine bench
```

Integration files end in `.integration.test.ts` and need a stack from `scripts/selfhost.sh up`.
`test/versions.property.test.ts` is one too. They start a real parse host, skip with the reason
on a machine without a stack, and fail in CI.

`bench/chunk.ts` needs no stack: a 100 KB page, p99 under 30 ms. `bench/save.ts` times a whole
`saveDraft` of a 100 KB page through the host, split into print, chunk and database stages, against
p95 under 150 ms, on 200,000 nodes at both ends of two tenants, and foreign key checks on a 233
chunk insert against 50 ms. Until `queryNodes` lands the bench writes the filter row itself, in the
same transaction, with every slot changing. Only the pinned Postgres 18 image counts, so it exits 1
on any other server. Set `DREFYN_BENCH_NODES` for a smaller table.
