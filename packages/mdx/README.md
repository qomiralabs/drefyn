# `@drefyn/mdx`

Turns customer Markdown and MDX into a tree we can store, and back into the same bytes. The
main entry is pure: no I/O, no logging, no clock. Customer MDX is a programming language and is never compiled or
evaluated here; ESM and expressions are kept as text, and `drefyn/no-mdx-evaluate` keeps the
compiler out of every package.

## Public API

Parsing lives in `@drefyn/mdx/isolated` and nowhere else; see "Parsing customer content".

- `serialize(root)` gives back the exact bytes. It throws `MdxPrintError` on a block that has
  no source, whose tree no longer hashes to `rawOf`, whose bytes no longer hash to `sourceOf`,
  or that carries `data`, and on text in a gap or the tail. The hashes have no key, so they
  catch stale bytes and not a writer who recomputes them.
- `rawOf(block)` is the SHA-256 of a block's canonical tree. Line endings, positions and
  parser data do not count, so a reformat is not a content change.
- `DEFAULT_LIMITS` and `AST_VERSION`.

Each top level block keeps `source: { raw, gapBefore, rawOf, sourceOf }`. `gapBefore` holds everything
since the previous block, so it ends at a line start and holds a BOM if the file has one. The
root keeps `tail`, everything after the last block, `tailOf`, its hash, and `eol`, the majority
line ending.

## Issue codes

| Code                      | Severity | Meaning                                                |
| ------------------------- | -------- | ------------------------------------------------------ |
| `mdx.parse_failed`        | error    | Not valid in this dialect                              |
| `mdx.too_large`           | error    | Over `maxBytes`, counted in UTF-8 bytes                |
| `mdx.too_deep`            | error    | Over `maxDepth`, or nesting that overflowed the parser |
| `mdx.too_many_nodes`      | error    | Over `maxNodes`, or past a scan or acorn budget        |
| `mdx.prop_not_literal`    | error    | A registry component with a prop that is not a literal |
| `mdx.esm_inert`           | warning  | ESM kept as text, never run                            |
| `mdx.expression_inert`    | warning  | Expression kept as text, never run                     |
| `mdx.unknown_component`   | warning  | Not in the registry, so it stays inert                 |
| `mdx.frontmatter_invalid` | warning  | Not core schema YAML; the bytes are still kept         |
| `mdx.dialect_mismatch`    | warning  | Looks like the other dialect                           |
| `mdx.parse_timeout`       | error    | Killed at the timeout                                  |
| `mdx.out_of_memory`       | error    | Ended by the heap cap                                  |
| `mdx.project_limit`       | error    | Project queue full or budget spent, try later          |
| `mdx.queue_full`          | error    | Pool queue full, try later                             |
| `mdx.parse_unavailable`   | error    | No thread could run it, says nothing about the page    |

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

`parseForStore` is not exported, so a request thread cannot call it. Every path that takes
customer content goes through one pool per process:

```ts
const pool = createParsePool(parsePoolConfig(process.env), { logger });
const result = await pool.parse({ organizationId, projectId, path, source, dialect, policy });
```

`parse` resolves with `{ ok: true, value }` or `{ ok: false, error }` for anything about the
page or the load, and rejects only on a malformed request, which is our bug. Nothing is stored
on a refusal. It never retries: a second try of a bomb is a second bomb. `mdx.project_limit`,
`mdx.queue_full` and `mdx.parse_unavailable` say nothing about the page, so the caller can
try again later, with its own backoff. A sync should feed pages in as earlier ones finish.

A thread starts on demand, runs one page at a time and is reused until it has served 256 pages.
A timeout, a heap overrun or a crash kills it, and the answer waits for the kill. A thread gets
an empty environment, no arguments and no streams, and gives up its network entry points before
it loads the parser. That last part is a seatbelt: a thread shares its process, so it can still
read what the process can read, and a real boundary is a process with a network policy.

| Key                              | Default | Meaning                                       |
| -------------------------------- | ------- | --------------------------------------------- |
| `DREFYN_PARSE_TIMEOUT_MS`        | 2000    | A thread is killed this long into a page      |
| `DREFYN_PARSE_WORKER_MEMORY_MB`  | 512     | Heap cap per thread                           |
| `DREFYN_PARSE_THREADS`           | 2       | Threads per process, at least 2               |
| `DREFYN_PARSE_QUEUE_MAX`         | 64      | Pages waiting across all projects             |
| `DREFYN_PARSE_PROJECT_THREADS`   | 1       | Threads one project can hold, under the total |
| `DREFYN_PARSE_PROJECT_QUEUE_MAX` | 16      | Pages one project can have waiting            |
| `DREFYN_PARSE_PROJECT_BUDGET_MS` | 30000   | Thread time one project can spend per window  |
| `DREFYN_PARSE_PROJECT_WINDOW_MS` | 60000   | Length of that window                         |

Projects take turns for a free thread, and a killed page spends its full timeout from the
budget, so a repo of bombs holds one thread for about fifteen pages a minute and is refused
past that. These limits are per process. The heap cap covers the JavaScript heap only, so
plan for threads times the cap and some native memory on top.

Each page logs `mdx.parse_finished` or `mdx.parse_refused`, and a kill logs
`mdx.parse_thread_killed` or `mdx.parse_thread_stuck`, with organization, project, path, byte
count, SHA-256 and timings. Page text never reaches a log, a result or a process stream.

## Commands

- `pnpm --filter @drefyn/mdx test`
- `pnpm --filter @drefyn/mdx test:fuzz` runs 60 s; `-- --seconds 5 --seed 1` narrows it.
- `pnpm --filter @drefyn/mdx bench` measures parse plus print against the budgets. Run it on
  an idle machine; it prints the load and exits 1 over budget.
