# `@drefyn/code-intel`

Reads source code for generation and staleness: exported symbols, their signatures and doc
comments, and HTTP routes. TypeScript, TSX, JavaScript, Python, Go and Rust, through
`web-tree-sitter` and the grammar packages' own prebuilt `.wasm` files. The grammars' native
bindings are never built or loaded.

## Extracting a file

```ts
import { extractFile, loadGrammars } from '@drefyn/code-intel';

const grammars = await loadGrammars();
const { symbols, routes, partial } = extractFile('typescript', source, grammars, { path });
```

`extractFile` is pure: the same source gives the same answer, and it reads, writes and logs
nothing. It has no time bound of its own, so repository code only reaches it through the host
below.

- A symbol is a `function`, `class`, `interface`, `type`, `const`, `method`, `struct`, `enum` or
  `trait`. Methods and items in inline Rust modules are named with their owner: `Client.list`,
  `auth.token`.
- `signature` is the declaration head on one line: no body, no constant value, no decorators,
  whitespace collapsed and a formatter's trailing comma dropped, so a reformat or a body edit is
  not a signature change.
- `doc` is the comment the language treats as documentation: `/** */` in TypeScript and
  JavaScript, the docstring in Python, `//` lines directly above in Go, `///` or `/** */` in
  Rust. `null` when there is none.
- `exported` follows each language: `export` and `export { name }` (a private or protected
  member is not exported); Python's literal `__all__`, else no leading underscore; a leading
  capital in Go, on both the method and its receiver; bare `pub` in Rust, inside modules that are
  `pub` themselves.
- `startLine` is the declaration's own line, after any decorators or attributes.

Routes are read where the framework's call is reliable:

| Language               | Frameworks                                                                  |
| ---------------------- | --------------------------------------------------------------------------- |
| TypeScript, JavaScript | Express, Fastify, Hono, Koa router, Next route handlers (`app/**/route.ts`) |
| Python                 | Flask, FastAPI, Django `path` and `re_path`                                 |
| Go                     | `net/http` (with 1.22 method patterns), gin, echo, chi                      |
| Rust                   | axum, actix-web, Rocket                                                     |

Paths are kept as the framework writes them. `method` is `ANY` where the framework takes every
method.

`partial` is true when the file has a syntax error (what parsed still comes back) or holds
something that was not followed: a computed route path, a router mounted under a prefix, a
dynamic `__all__`, an item level Rust macro. Re-exports from other files are not followed and
do not set it; following them across files is the caller's work.

## The host

```ts
import { createExtractHost, DEFAULT_EXTRACT_CONFIG } from '@drefyn/code-intel';

const host = createExtractHost(DEFAULT_EXTRACT_CONFIG, { logger, onStuck });
const answer = await host.extract({ tenant, path, language, source });
```

The host runs one file at a time on a worker thread sealed by `@drefyn/mdx/seal-thread` (no
network, no child processes, no new threads, no native addons), with a memory cap and a time
limit. A grammar runs in WebAssembly that never yields, so the kill is the only bound: at the
limit the thread is ended and the next file gets a new one. It belongs inside the parse host in
its repo role, which adds `--permission`, an empty environment and a closed network.

| Code                 | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `code.timeout`       | The file ran past `timeoutMs` and its thread was killed                |
| `code.out_of_memory` | The thread hit `maxMemoryMb`                                           |
| `code.failed`        | The thread crashed or answered in the wrong shape                      |
| `code.unavailable`   | The thread did not start, or a stuck thread is taking the process down |
| `code.too_large`     | Over `maxSourceBytes`, refused before it queued                        |
| `code.queue_full`    | `maxQueued` files already wait                                         |
| `code.closed`        | The host is closing or closed                                          |

A refused file is never retried: a second try of a slow file is a second slow file. When a
thread cannot be ended, `onStuck` runs; the parse host ends its process there and its supervisor
starts a new one.

Logs carry organization, project, path, language, byte and symbol counts, and timings. Never
file text.

## Commands

- `pnpm --filter @drefyn/code-intel test`
- `pnpm --filter @drefyn/code-intel bench` prints extraction time per 1,000 lines per language.
