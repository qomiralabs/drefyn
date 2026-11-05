# `@drefyn/mdx`

Turns customer Markdown and MDX into a tree we can store, and back into the same bytes. The
main entry is pure: no I/O, no logging, no clock. Customer MDX is a programming language and is never compiled or
evaluated here; ESM and expressions are kept as text, and `drefyn/no-mdx-evaluate` keeps the
compiler out of every package.

## Public API

- `parseForStore(source, dialect, policy)` parses `.mdx` as `'mdx'` and `.md` as `'md'`. It
  returns `{ ok: true, value: { ast, issues } }`, with warnings in `issues`, or
  `{ ok: false, error: issues }`. It throws only on a bad policy or dialect, which is our bug
  and not bad content.
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

Issues carry a code, severity, line and column, and never customer text.

## Hostile input

The parser cannot be bounded from inside. Its cost lives in third party resolvers and regular
expressions that rescan a paragraph per opener and never yield, so limits checked on a finished
tree come too late: 50 KB of the right bytes holds a thread for over 20 s and 576 MB of memory.

The only hard limit is `parseIsolated`, from `@drefyn/mdx/isolated`. It runs the parse in a
thread with a heap cap and kills the thread at the timeout, which also ends a stall inside a
regular expression. It returns `mdx.parse_timeout` or `mdx.out_of_memory`. Customer content
goes through it; `parseForStore` on a request thread is never safe.

In front of that sit best effort checks, which make most refusals cheap and bound nothing.
Size comes first. A linear scan estimates work as openers times paragraph length, since every
opener is ASCII punctuation, and refuses a page far above any real one. A byte budget stops the
acorn retries in MDX. An explicit stack walks the tree, so a deep tree cannot overflow the check
meant to refuse it. The slowest page these let through in a search of 1,040 generated 1 MiB
pages and pages tuned to each limit took 9.8 s, and a search does not prove that is the worst.

A page refused by the scan or the budget gets `mdx.too_many_nodes` at line 1.

## Commands

- `pnpm --filter @drefyn/mdx test`
- `pnpm --filter @drefyn/mdx test:fuzz` runs 60 s; `-- --seconds 5 --seed 1` narrows it.
- `pnpm --filter @drefyn/mdx bench` measures parse plus print against the budgets. Run it on
  an idle machine; it prints the load and exits 1 over budget.
