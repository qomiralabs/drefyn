# `@drefyn/mdx`

Turns customer Markdown and MDX into a tree we can store, and back into the same bytes. The
main entry is pure: no I/O, no logging, no clock. Customer MDX is a programming language and is never compiled or
evaluated here; ESM and expressions are kept as text, and `drefyn/no-mdx-evaluate` keeps the
compiler out of every package.

## Public API

Parsing and printing live in the parse host and nowhere else. `@drefyn/mdx/client` is the only
way in; see "Parsing customer content".

- `rawOf(block)` is the SHA-256 of a block's canonical tree. Line endings, positions and
  parser data do not count, so a reformat is not a content change.
- `DEFAULT_LIMITS` and `AST_VERSION`.

Each top level block keeps `source: { raw, gapBefore, rawOf, sourceOf }`. `gapBefore` holds everything
since the previous block, so it ends at a line start and holds a BOM if the file has one. The
root keeps `tail`, everything after the last block, `tailOf`, its hash, and `eol`, the majority
line ending.

## Changed blocks

`client.print({ tenant, path, root, policy })` gives back the bytes of a tree. A block prints its
stored bytes only while its tree still hashes to `rawOf`. A block with no source, or one that
moved on, goes through the one canonical printer, whose options are fixed in code. Changing them
is an `astVersion` bump, and stored blocks are never reprinted because of it.

It refuses with `mdx.block_not_printable` on bytes that no longer hash to `sourceOf`, on `data`
anywhere in a tree, on text in a gap or the tail, on a node the dialect cannot hold, on a JSX or
attribute name outside the MDX syntax, on frontmatter anywhere but the first block, and on a tree
past the limits in its policy. The hashes have no key, so they catch stale bytes and not a writer
who recomputes them.

`/parse`, `/print` and `/merge` all name the organization in `x-drefyn-organization`, checked against the frame, so a body can be refused before it is read. Bodies and jobs count against `DREFYN_PARSE_MAX_HELD_BYTES`, with a quarter for any one organization, and a refusal is `mdx.queue_full` with a 429.

Every print is reparsed in the same thread, under the same policy. If any block or live node
differs from the tree, it refuses with `mdx.print_changed_meaning`: that is how a new block hidden
by an unclosed fence, or an expression that closes itself early, stops here. Text inside a block
may settle differently, as a typed URL becomes a link. A block printed from stored bytes has to come back as exactly its tree, so forged bytes
cannot change even its text, though a definition elsewhere can still turn `[a]` into a reference.
**Store the `ast` the call hands back, never the tree you sent.** Only that one is known to agree with what git will hold, and render policy
has to run on it. Everything that writes a tree, the editor save and `merge3` included, goes
through this. **`source` comes only from the stored row, never from a client or an editor
document.** Check that where a tree enters the app: the hashes have no key, and the reparse only
sees bytes that change what a block says.

Untouched blocks keep their bytes, so a file never gets reformatted behind its author's back. A
changed block reprints whole, which means a one word edit is one line only if the block was
already canonical. A list written with `*` rewrites every line of that list, and no other block.

Reprinting a block moves what sits next to it, so `serialize` handles three cases the tree cannot
see. A gap with no blank line stays only where both neighbours are safe with one line between
them, and opens up otherwise. Two neighbouring lists with one marker are one list to a parser, so
the second takes another marker, even if it was untouched. A file cannot open with a printed `---`,
which would start frontmatter, so that rule prints as `***`.

## Merging

`client.merge({ tenant, path, base, ours, theirs, policy })` runs a three way merge in the host,
under the same queues, budgets and kill as a print. It answers `{ outcome, issues }`, where
`outcome` is `{ kind: 'clean', merged }` or `{ kind: 'conflict', partial, conflicts }`.

- Nothing is ever dropped to resolve an overlap. Each side lines up against the base one slot at a
  time, so an edit, an insert or a delete either lands or becomes a `BlockConflict` with both
  versions in it. Below the top level a conflict takes the whole block to a person.
- `reason` is `both_changed`, `delete_vs_edit`, `both_inserted` or `move_vs_edit`. A record with
  `baseIndex`, `ours` and `theirs` all null means every block merged but the page cannot be stored
  as a whole, as when a fence left open at the end of a file swallows what a move put after it.
- Lists, tables and quotes recurse, and a paragraph, heading or table cell edited on both sides
  merges word by word. Code, HTML, JSX and frontmatter do not: two edits to one of those conflict.
- Blocks compare on a hash of their own tree, never on the hash they carry, so a reformat raises
  no conflict and keeps its bytes.
- A moved block takes the other side's edit with it. A move next to the other side's insert, or
  against its delete, is a conflict.
- `partial` is for showing a person. It can hold both sides of a conflict and is never a version.
- **A clean result is not yet a version: send `merged` through `client.print` and store the `ast`
  that comes back.** `source` on all three trees comes from stored rows and fresh parses, as it
  does for a print.

An untouched block changes bytes in one more case here. A block written with leading indent that
ends up under a new neighbour reprints, since the indent would read as part of a list above it.

`DREFYN_MDX_MERGE_MAX_BLOCKS` caps any one of the three trees, default 20000. Past that, or past
the limits in the policy, a merge refuses with `mdx.merge_limit`. It is the one setting the host
takes outside `DREFYN_PARSE_`. The three trees also count against held bytes, so
`DREFYN_PARSE_MAX_HELD_BYTES` has a floor of four times the largest merge body.

`pnpm --filter @drefyn/mdx test:merge` runs the property test at 100,000 cases. The gate runs a
slice of it on a fresh seed each time. `MERGE_PROPERTY_SEED` replays a failure.

## Issue codes

| Code                        | Severity | Meaning                                                |
| --------------------------- | -------- | ------------------------------------------------------ |
| `mdx.parse_failed`          | error    | Not valid in this dialect                              |
| `mdx.too_large`             | error    | Over `maxBytes`, counted in UTF-8 bytes                |
| `mdx.too_deep`              | error    | Over `maxDepth`, or nesting that overflowed the parser |
| `mdx.too_many_nodes`        | error    | Over `maxNodes`, or past a scan or acorn budget        |
| `mdx.prop_not_literal`      | error    | A registry component with a prop that is not a literal |
| `mdx.esm_inert`             | warning  | ESM kept as text, never run                            |
| `mdx.expression_inert`      | warning  | Expression kept as text, never run                     |
| `mdx.unknown_component`     | warning  | Not in the registry, so it stays inert                 |
| `mdx.frontmatter_invalid`   | warning  | Not core schema YAML; the bytes are still kept         |
| `mdx.dialect_mismatch`      | warning  | Looks like the other dialect; an error in a merge      |
| `mdx.parse_timeout`         | error    | Killed at the timeout                                  |
| `mdx.out_of_memory`         | error    | Ended by the heap cap                                  |
| `mdx.organization_limit`    | error    | Organization queue full or budget spent, try later     |
| `mdx.project_limit`         | error    | Project queue full or budget spent, try later          |
| `mdx.queue_full`            | error    | Pool queue full, try later                             |
| `mdx.block_not_printable`   | error    | A tree that cannot be printed; see "Changed blocks"    |
| `mdx.print_changed_meaning` | error    | Its print would parse as something else                |
| `mdx.merge_limit`           | error    | A merge past its block or tree limits                  |
| `mdx.parse_unavailable`     | error    | No thread could run it, says nothing about the page    |

Issues carry a code, severity, line and column, and never customer text.

## Hostile input

The parser cannot be bounded from inside. Its cost lives in third party resolvers and regular
expressions that rescan a paragraph per opener and never yield, so limits checked on a finished
tree come too late: 50 KB of the right bytes holds a thread for over 20 s and 576 MB of memory.

The only hard limit is a killed thread. Time is not a bound: a page can take as long as the
parser likes until the kill lands, and the kill is what holds. A hostile page costs a full
timeout, so size every limit below on that and not on any measured time.

In front of that sit best effort checks, which make most refusals cheap and bound nothing.
Size comes first. A linear scan estimates work as openers times paragraph length, since every
opener is ASCII punctuation, and refuses a page far above any real one. A byte budget stops the
acorn retries in MDX. An explicit stack walks the tree, so a deep tree cannot overflow the check
meant to refuse it. A search of generated pages tells you nothing about the worst
case: pages of lazy lines pass all of these and run past 25 s at 125 KB.

A page refused by the scan or the budget gets `mdx.too_many_nodes` at line 1.

## Parsing customer content

`parseForStore` and the printer are not exported, and nothing a caller can import reaches them.
The printer has the same problem as the parser: a third party attention solver retries a render
per mistake and never yields, so a 9 KB page that parses in 75 ms held it for 11 s. Limits on a
tree only make most refusals cheap. Every path that takes customer content calls the parse host,
a separate process, and prints and parses share its threads, queues, budgets and kill. There is no in process
fallback: if the host is down, a save refuses and the last good version stays.

```ts
const client = createParseClient({ url: process.env.DREFYN_PARSE_HOST_URL });
const result = await client.parse({ tenant, path, source, dialect, policy });
```

`parse` resolves with `{ ok: true, value }` or `{ ok: false, error }` and does not throw. Nothing
is stored on a refusal, and nothing retries: a second try of a bomb is a second bomb.
`mdx.organization_limit`, `mdx.project_limit`, `mdx.queue_full` and `mdx.parse_unavailable` say
nothing about the page, so the caller can try later, with its own backoff. A sync should feed
pages in as earlier ones finish.

### The host

```sh
node --permission --allow-fs-read=<code dir> --allow-worker packages/mdx/src/host-main.ts
```

The host is the boundary, not its threads. It refuses to start without `--permission`, or with
any environment key outside `DREFYN_PARSE_*` and the few a container sets for itself, so it holds
no credentials. Egress has to be closed by the platform: Node has no network permission, and a
loopback connect works under `--permission`. **The compose service and security group that close
it are separate work, and no customer content may reach this until they exist.** Set a hard OS
memory limit of `DREFYN_PARSE_HOST_MEMORY_MB` on the service; the heap cap does not cover native
memory.

A thread runs one page and is reused for up to 256 pages, between tenants. A timeout, a heap
overrun or a crash kills it, and the answer waits for the kill. If `terminate` has not finished
after the grace, the stall is in native code and only the process can end it, so the host
SIGKILLs itself. Pages in flight get `mdx.parse_unavailable`, and the supervisor restarts it.

Inside a thread there is an empty environment, no arguments, no streams to ours, and a seal over
network, child process, worker and debugger entry points. The seal is a seatbelt: it stops no
code that is determined to get out, and proves nothing about the network.

| Key                              | Default   | Meaning                                                   |
| -------------------------------- | --------- | --------------------------------------------------------- |
| `DREFYN_PARSE_TIMEOUT_MS`        | 2000      | A thread is killed this long into a page                  |
| `DREFYN_PARSE_PRINT_TIMEOUT_MS`  | 6000      | The same for a print, which holds a whole parse too       |
| `DREFYN_PARSE_WORKER_MEMORY_MB`  | 512       | Heap cap per thread                                       |
| `DREFYN_PARSE_THREADS`           | 2         | Threads per host, at least 2                              |
| `DREFYN_PARSE_QUEUE_MAX`         | 64        | Pages waiting across all organizations                    |
| `DREFYN_PARSE_ORG_THREADS`       | 1         | Threads one organization can hold, under total            |
| `DREFYN_PARSE_ORG_QUEUE_MAX`     | 32        | Pages one organization can have waiting                   |
| `DREFYN_PARSE_ORG_BUDGET_MS`     | 30000     | Thread time per window for an organization                |
| `DREFYN_PARSE_PROJECT_THREADS`   | 1         | Threads one project can hold, inside its org              |
| `DREFYN_PARSE_PROJECT_QUEUE_MAX` | 16        | Pages one project can have waiting                        |
| `DREFYN_PARSE_PROJECT_BUDGET_MS` | 20000     | Thread time per window for a project                      |
| `DREFYN_PARSE_WINDOW_MS`         | 60000     | Length of the budget window                               |
| `DREFYN_PARSE_MAX_HELD_BYTES`    | 268435456 | Bytes of bodies and jobs held, a quarter per organization |
| `DREFYN_MDX_MERGE_MAX_BLOCKS`    | 20000     | Blocks in any one tree of a merge                         |
| `DREFYN_PARSE_KILL_GRACE_MS`     | 2000      | Wait after `terminate` before SIGKILL                     |
| `DREFYN_PARSE_HOST_MEMORY_MB`    | 1536      | At least threads times the cap, held bytes, plus 256      |
| `DREFYN_PARSE_PORT`              | 8787      | Port the host listens on                                  |

### What the limits hold against

Organizations take turns for a free thread, and projects take turns inside one, so a tenant
gets the same share however many projects it makes. One organization can never hold every
thread or fill the queue, so one bad tenant leaves a thread and queue places free.

Limits are per host. Several organizations acting together can still fill the threads and the
queue; two can at these defaults, each at the cost of its own budget. With several hosts every
budget is per replica, so a cluster wide bound needs a shared counter.

The 512 MB cap refuses some plain 1 MiB pages with `mdx.out_of_memory`, so 1 MiB is an upper
limit and not a size this pool accepts in general.

Each page logs `mdx.parse_finished` or `mdx.parse_refused`, and a kill logs
`mdx.parse_thread_killed` or `mdx.parse_thread_stuck`, with organization, project, path, byte
count, SHA-256 and timings. Page text never reaches a log, a result or a process stream.

## The frozen tree

`node_versions.content` holds an `MdxRoot`, and `ast_version` says which shape it has. The version
only goes forward, because stored content stays in the shape it was written in.
`test/fixtures/ast/v<n>.json` pins the stored tree of each case in `test/ast-cases.ts` for version
`n`, and `test/ast-freeze.test.ts` fails when the parser gives anything else. That covers new
fields, renamed node types, changed hashes and a parser upgrade that moves any of them.

If it fails and the change is meant:

1. Raise `AST_VERSION` in `src/types.ts`.
2. Run `pnpm --filter @drefyn/mdx pin:ast`, which writes the new pin. It refuses to replace one.
3. Keep every older pin. Stored content still looks like them.

## Commands

- `pnpm --filter @drefyn/mdx test`
- `pnpm --filter @drefyn/mdx test:fuzz` runs 60 s; `-- --seconds 5 --seed 1` narrows it.
- `pnpm --filter @drefyn/mdx test:mutation` runs Stryker over the printer, `serialize`, the print
  job, its checks and the hashes, and fails at 10 percent of mutants surviving. It uses the exact byte tests only, as
  the corpus and generated suites take minutes a mutant.
- `pnpm --filter @drefyn/mdx bench` measures parse plus print against the budgets. Run it on
  an idle machine; it prints the load and exits 1 over budget.
