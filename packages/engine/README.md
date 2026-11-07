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

- `createEngine(deps)`: the calls below, over a store, a parse client, flags and a policy.
  `databaseStore(db, config)` makes the store from a `@drefyn/db` database and its config. Call it
  at startup: it refuses a ceiling at or above the pool, and any number of calls on one database
  share one gate.
- `parseEngineConfig(env)`: reads the caps below.
- `runFilterBackfill(engine, tenant)`: fills or clears slots at the paced rate, until none are
  queued. A job calls this; the work resumes from the table.
- `chunkNode(content, options)`: splits a tree into block aligned chunks. Pure: the same content
  and options give the same chunks in the same order.

The database refuses a `family`, `lifecycle` or `origin` outside these lists, and a test here
compares each list with the migration, so the two cannot drift.

## Writing content

| Call            | Does                                                                             |
| --------------- | -------------------------------------------------------------------------------- |
| `createNode`    | Adds a node with no version. Its id always comes from the database.              |
| `saveDraft`     | Adds a version when `expectedHeadVersionId` is still the head.                   |
| `rollback`      | Adds a version with an older version's content, and keeps that version's origin. |
| `moveNode`      | Puts a node under a parent, after a sibling. Writes that one row.                |
| `getHead`       | Reads the head, content included.                                                |
| `listVersions`  | Lists versions newest first, without content.                                    |
| `declareSchema` | Stores a type's definition and gives declared fields their slots.                |
| `queryNodes`    | Lists a type's nodes, filtered and sorted.                                       |

Every call returns a `Result`, and only a bug throws. `engine.not_found` covers another tenant's
ids as well, so a caller cannot tell them apart. `engine.unavailable` is the one retryable code:
the database or parse host is down or full, and nothing was stored. Writes need the `engine.writes`
flag, off in production, and are `engine.forbidden` without it. Reads never need it.

`moveNode` takes a parent and the sibling to land after, and writes one row, however large the
subtree. Keys come from the server. Moves in a project queue on one advisory lock, so two moves
that would close a cycle cannot both pass: the second sees the first and gets
`engine.validation_failed` with `engine.cycle` on `parentId`. A parent or sibling that is another
tenant's, deleted, or not a child of that parent is `engine.not_found`, with nothing naming which.
`createNode` lands after the last sibling unless the caller sends `orderKey`. A key the caller sent
can tie with a sibling, and nothing fits between a tie, so a move there gets
`engine.order_key_no_room`. One gap takes about 6,000 inserts in a row before `engine.too_large`.

A tree is at most 64 levels, a root being level 1. `createNode` under a parent and `moveNode`
refuse anything past that with `engine.validation_failed` and `engine.tree_too_deep` on `parentId`,
and a move counts the height of the subtree it carries. Rows already deeper stay readable and
saveable, and can always move up, along or to the root. A move down that would have to read more
than 50,000 rows of its subtree is `engine.too_large` on `nodeId`.

Writers that pick a place in a tree wait at most 1 s for the project's lock, then answer
`engine.unavailable` with nothing written. Each process lets 2 such writes per project reach the
pool. A root created with its own `orderKey` skips that lane, not the ceiling below.

## Protecting the pool

One gate per pool holds `createNode`, `saveDraft`, `rollback`, `moveNode`, `declareSchema` and
`queryNodes` to `DREFYN_ENGINE_POOL_CEILING` connections between them, whichever tenants and however
many projects are busy. The rest of the pool is for what the gate does not cover: `getHead`,
`listVersions`, filter backfill batches, and anything else the app runs on that database.

The ceiling is shared, not split. An organization may take one more place while it holds less than
what is still free, so one alone reaches half the ceiling, several share what they leave, and one
with nothing running gets in while any place is free. At the default of 8, three organizations
taking all they can stop at 7, and a fourth is answered. Writes stop at three quarters of the
ceiling, as a stalled write holds its place for seconds, so stalls cannot shut lists out. That is
6 writes and an organization's 3 at the default, and lists can use the rest.

A write with no place waits off the pool, for at most 1 s, in a queue of `DREFYN_ENGINE_POOL_QUEUE`
for the process, shared the same way. Then it gets `engine.unavailable` with nothing written, and
logs `engine.pool_busy` with the ids and the load. A list never waits.

`databaseStore` throws at startup when the ceiling is at or above `DREFYN_DATABASE_POOL_MAX`, naming
both keys, so a pool of 8 or less needs a lower ceiling and a pool of 1 cannot run the engine. Raise
the two together on a large machine: this is a limit on the machine and no plan sells it, so it is
config and not an entitlement. Each process has its own pool and its own gate.

A gated transaction keeps its connection for at most `DREFYN_ENGINE_SLOT_HOLD_MS`, 15 s by default.
Past that the connection is closed from this side, the caller gets `engine.unavailable`, and the pool
replaces it. Timeouts in Postgres cannot do this: a socket that stopped answering never hears them.
A write cut off at the commit may have landed, so retry with the same `idempotencyKey`.

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

A docs page keeps no second copy of its tree: `nodes.head_content` stays null, and `getHead` reads
the head version by key. Studio items keep the copy, as their list scans read it.

`node_versions` is append only: `drefyn_app` holds select and insert on it and nothing more. Limits
come from `@drefyn/entitlements` and count per organization in `organization_node_counts`, updated
in the transaction that creates the node. A read only organization or project, or one over its
limit after a downgrade, gets `engine.read_only` on writes, and reads go on working.

## Chunks

With `engine.chunk_at_write` on, off in production, a save or rollback writes the version's chunks
and one `embed_chunks` row in `engine_outbox` in the version's own transaction, so a version never
commits without them. Embedding runs later and never in this path. A replay writes nothing, and a
page with no text gets no outbox row. Chunks belong to a version and are not replaced by the next.
A failed read of that flag refuses the write with `engine.unavailable` and logs
`engine.flag_read_failed`, as counting it as off would commit a version with no chunks.

A chunk is made of whole blocks and starts again at every heading, so a word edited in one section
cannot move text in another. It closes before it passes the target. A block over the target splits
at line ends, and a line over the cap is cut at the cap. `chunkNode` runs before the transaction
on a save, and under the lock on a rollback, where a replay must not pay for it.

Chunk text is read off the tree through a closed list of node types, so frontmatter, comments,
imports, expressions, link targets and component props stay out. This is a stopgap, and it is not
yet what a reader sees: text between split raw HTML tags, children of unknown components and orphan
footnotes still reach a chunk. Keep `engine.chunk_at_write` off until #416 takes chunk text from
the render. Heading text is capped at 200 characters and heading paths share a budget of 262,144
characters a page, split evenly across its headings. Past its share a chunk has an empty path, so
one save cannot grow by repeating a long path on every row, and an edit in one section cannot
change the paths of another.

A save opens the spans `engine.save`, `engine.save.verify`, `engine.save.chunk` and
`engine.save.write`. The parse host reports its steps, and the engine records them through
`tracer.record` as `engine.save.host.queue`, `.thread`, `.decode`, `.print`, `.reparse` and
`.compare`. Those are times only, and the same fields appear on the host's `mdx.parse_finished` line.

## Fields and filter rows

Field values travel beside the content: `saveDraft` takes `fields`, a map of field id to value in
API form, with decimal strings for numbers, ISO strings for dates, booleans, and lists. Leave it
out and the head's values carry over, so an edit to a body cannot wipe them. The values are held to
the type's definition and stored in a canonical form on the version, with a copy in
`nodes.head_fields`: numbers as integer units in a string, never a JSON number, and dates as UTC
instants. Rich text, assets and objects live in content and are refused here.

A field declared `filterable` or `sortable` takes one slot on `app.node_filter_rows`, up to 5 text,
5 integer and 2 time, for life. A list takes the list column of a text slot. A definition whose row
could pass the btree tuple limit is refused when declared, so a valid save can never hit it. The
row is written in the save's transaction, and the statement itself compares, so a save that changes
no slot writes nothing. A rollback brings the old slots back with the old content.

Declaring a field on a type with items starts a backfill. Until it ends the field behaves as
undeclared, `queryNodes` lists it in `backfilling` so a page can say why, and past the scan limit
filters on it get `engine.filter_backfilling`. Batches are 250 rows with 200 ms between them, one
backfill per organization at a time, and each batch locks its nodes first, in id order, so it cannot
write over a racing save. A removed field's slot is cleared the same way before it can be reused.

## Listing

`queryNodes(tenant, { typeId, filter, sort, limit, cursor })` compiles a closed `FilterNode` from
`@drefyn/schema` to one parameterized statement. Values and field ids are always bound, and the only
identifiers come from a fixed column list, so nothing a caller sends reaches SQL text. Statements
are unnamed: a named one gets a generic plan, which took 341,004 buffers against 18.

| Filter                                        | What runs                              | Budget at 200,000 items in a type                            |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------ |
| Declared: `eq`, `in`, ranges, `neq`, `exists` | One scan of the covering key           | p95 under 100 ms per shape, p99 under 250 ms, writes running |
| Declared text: `contains`                     | The same, with a substring test        | p95 under 200 ms                                             |
| Undeclared, 20,000 items or fewer             | A scan of `head_fields`, never content | p95 under 50 ms                                              |
| Undeclared, above that                        | `engine.filter_not_declared`, by field | Refused, never a slow query                                  |

A value that is missing is false to every comparison except `neq`, and `not` flips that cleanly, so
`not eq` and `neq` agree. `contains` has no pattern language and ignores case. Sorting needs a
declared `sortable` field, nulls come last in both directions, and pages walk by an opaque cursor
that holds only to the order it came from. With no sort, newest first. Each statement of a list has its own
`DREFYN_ENGINE_QUERY_TIMEOUT_MS`, and one that passes it returns `engine.unavailable` and no partial
page.

A cursor names a node, the order and nothing else, so no field value is in a URL or an access log.
The sort value is read back from that node on the next page. A cursor naming a node the tenant
cannot see answers `engine.cursor_invalid`. Editing the sort field of the last item shown between
two pages moves the place with it, so that walk can skip or repeat items near the edit.

An organization runs at most `DREFYN_ENGINE_QUERY_MAX_IN_FLIGHT` lists at once in each process. The
next one gets `engine.unavailable`, issue code `engine.query_busy`, and logs `engine.query_busy`.
Nothing queues. The count lives in the gate, so engines over one pool share it. A list that finds
the ceiling full gets the same answer. A date of year 0000 is refused on a save and in a filter, and
one stored before that reads as missing.

`drefyn maintain filter-rows` runs as the migration role, as vacuum and a rebuild need the table's
owner. It rebuilds the key with `reindex concurrently` past 30 percent bloat, estimated from the
key's size against the heap, one run at a time, and prints one JSON line of counts with any alerts:
`engine.filter_rows.old_transaction` past 5 minutes and `engine.filter_rows.dead_tuples` past
20,000. Add `--after-import` once a bulk import ends: it runs `vacuum (analyze)`, as `analyze` alone
makes plans worse, and always rebuilds. The filter rows are shared by every tenant, so this is table
work and never tenant work. The role sees other roles' transactions only with `pg_read_all_stats`.

## Configuration

| Key                                       | Default | Meaning                                               |
| ----------------------------------------- | ------- | ----------------------------------------------------- |
| `DREFYN_ENGINE_MAX_NODE_BYTES`            | 1048576 | Source bytes of one node. Can only be lowered.        |
| `DREFYN_ENGINE_MAX_TREE_BYTES`            | 5242880 | Stored JSON of one version, at most 16777216.         |
| `DREFYN_CHUNK_TARGET_CHARS`               | 800     | Close a chunk before it passes this. At most the cap. |
| `DREFYN_CHUNK_MAX_CHARS`                  | 2000    | Hard cap on a chunk, whatever the page holds.         |
| `DREFYN_ENGINE_QUERY_TIMEOUT_MS`          | 2000    | `statement_timeout` for `queryNodes`, at most 60000.  |
| `DREFYN_ENGINE_QUERY_MAX_IN_FLIGHT`       | 4       | Lists at once, per organization, per process.         |
| `DREFYN_ENGINE_POOL_CEILING`              | 8       | Lists and writes on the pool, at most 1024.           |
| `DREFYN_ENGINE_POOL_QUEUE`                | 64      | Writes waiting off the pool, at most 4096.            |
| `DREFYN_ENGINE_SLOT_HOLD_MS`              | 15000   | Longest hold of a connection, at least 5 lists.       |
| `DREFYN_ENGINE_UNDECLARED_SCAN_MAX_ITEMS` | 20000   | Largest type an undeclared filter may read.           |

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
chunk insert against 50 ms, with every slot changing on every save. `bench/query.ts` runs every
list shape on a 200,000 item type with all 12 slots filled, first with no writes, then with 50 saves
a second, 20 percent changing slots, and against the undeclared scan budget at 20,000 items. Its
saves skip the parse host, which runs in another process and whose budget would stop one project
near 12 saves a second. Both exit 1 on any server but the pinned Postgres 18 image, which is the
only run that counts. Set `DREFYN_BENCH_NODES` for a smaller table, and `DREFYN_BENCH_SECONDS` for
a shorter write run. A run above load 10 is void and fails. `bench/pool.ts` stalls a crowd of tree
writes, lists and saves, and times what that costs a tenant that did nothing. It compares two
builds and has no budget, so any server will do; it exits 1 if the quiet tenant saw a failure.
