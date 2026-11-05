# `@drefyn/mdx`

Turns customer Markdown and MDX into a tree we can store, and back into the same bytes. Pure:
no I/O, no logging, no clock. Customer MDX is a programming language and is never compiled or
evaluated here; ESM and expressions are kept as text, and `drefyn/no-mdx-evaluate` keeps the
compiler out of every package.

## Public API

- `parseForStore(source, dialect, policy)` parses `.mdx` as `'mdx'` and `.md` as `'md'`. It
  returns `{ ok: true, value: { ast, issues } }`, with warnings in `issues`, or
  `{ ok: false, error: issues }`. It throws only on a bad policy or dialect, which is our bug
  and not bad content.
- `serialize(root)` gives back the exact bytes. It throws `MdxPrintError` on a block that has
  no source, or whose tree no longer hashes to `rawOf`, until the canonical printer exists.
- `rawOf(block)` is the SHA-256 of a block's canonical tree. Line endings, positions and
  parser data do not count, so a reformat is not a content change.
- `DEFAULT_LIMITS` and `AST_VERSION`.

Each top level block keeps `source: { raw, gapBefore, rawOf }`. `gapBefore` holds everything
since the previous block, so it ends at a line start and holds a BOM if the file has one. The
root keeps `tail`, everything after the last block, and `eol`, the majority line ending.

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

Limits checked on a finished tree come too late, because micromark and the acorn retries in
MDX go quadratic: 50 KB of the right bytes held a thread for over 20 s. So size is checked
first, a linear scan refuses the known shapes, a byte budget stops acorn retrying, and an
explicit stack walks the tree so a deep tree cannot overflow the check meant to refuse it.

That narrows the worst case to about 7 s for a 1 MiB page and does not close it. Run
`parseForStore` in the parse worker with `DREFYN_PARSE_TIMEOUT_MS`, never on a request thread.
A page refused by the scan or the budget gets `mdx.too_many_nodes` at line 1.

## Commands

- `pnpm --filter @drefyn/mdx test`
- `pnpm --filter @drefyn/mdx test:fuzz` runs 60 s; `-- --seconds 5 --seed 1` narrows it.
- `pnpm --filter @drefyn/mdx bench` measures parse plus print against the budgets. Run it on
  an idle machine; it prints the load and exits 1 over budget.
