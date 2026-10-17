# `@drefyn/lint-rules`

Repo tooling that keeps workspace packages behind their public entry points and keeps
outbound network calls behind `@drefyn/egress`. The root `eslint.config.js` loads the
rules for every package at severity `error`.

## Rules

`drefyn/no-cross-package-internals` resolves each import to the workspace package
that owns it, using `pnpm-workspace.yaml`, and reports:

- `internal`: a relative path into another package, such as `../x/src/internal.ts`,
  including one that goes through a `node_modules` link to it.
- `app`: a relative path into an app. Apps are never imported.
- `linked`: any other relative path through `node_modules`. Import the package by name.
- `unexported`: a bare `@drefyn/x/<sub>` that is not a key in x's `exports`.
- `undeclared`: a bare `@drefyn/x` missing from the importer's `dependencies` and
  `devDependencies`.

It checks static, type only and dynamic imports, re-exports, `import('x').T` types and
`require()`. Builtins, URLs, `#imports`, absolute paths and npm packages are left to
Node, tsc and the exports maps. Files at the repo root outside every package (such as
`vitest.shared.ts`) are open to every package.

`drefyn/no-raw-egress` reports `node:http`, `node:https`, `node:http2`, `node:net`,
`node:tls`, `node:dgram`, `node:dns`, `node:dns/promises`, `node:quic`, the `_http_*`,
`_tls_*` and `_stream_wrap` internals behind them, and `undici`, each with or without
`node:`. It catches them in imports, re-exports, `require()`, `module.require()`,
`process.getBuiltinModule()` and a require made by `createRequire()` (under any name
it is imported as), with a string or a template with no `${}`. It also reports any
runtime use of the global `fetch` or `WebSocket`: bare, through `globalThis`,
`window`, `self` or `global` (chained, destructured or behind `as`, `!`, `<T>` or
`satisfies`), and when the only binding is an ambient `declare`. Type only imports
pass.

A require style load of a relative file with an extension other than a source one or
`.json` (`require('./net.txt')`) is reported too: Node runs it as JavaScript, and
nothing lints it. ESM imports of assets such as CSS are left alone for bundlers.

The exemption belongs to the `@drefyn/egress` package at `packages/egress`, decided by
the owning manifest, not by the path. Other exceptions go in
`src/egress-allow-list.ts`, each with a `path` relative to the repo root (a trailing
`/` covers a directory) and a `reason`. The config fails to load if either is missing.
Every new entry needs a security review.

ESLint reads manifests once per process. Restart an editor's ESLint server after
changing a `package.json` or `pnpm-workspace.yaml`.

### What the egress rule does not catch

The rule reads code; it does not run it. These still get out, and the runtime
controls (an egress worker role with no permissions and the network policy) are what
stop them:

- `eval`, `new Function`, `Function.prototype.constructor` and `new Worker(code, { eval: true })`
- `child_process` running `curl` or another binary
- `process.binding('tcp_wrap')` and other native bindings
- `import()` or `require()` with a computed specifier, such as `import('node:' + x)`
- an aliased require (`const r = require; r('http')`), a require from `createRequire`
  assigned later (`let r; r = createRequire(...)`), and `.call` or `.apply` forms
  (`require.call(null, 'http')`, `process.getBuiltinModule.call(process, 'node:http')`)
- `getBuiltinModule` taken off `process` first (`const { getBuiltinModule } = process`)
- computed or indirect global access: `globalThis[k]`, `Reflect.get(globalThis, 'fetch')`,
  `const g = globalThis; g.fetch()`, `(0, globalThis).fetch`,
  `const { ...rest } = globalThis; rest.fetch`
- an `imports` map entry that points at a builtin (`"#net": "net"`)
- npm network clients (`axios`, `ws`, `pg` and the like); dependency review covers
  them today

## Manifest checker

`pnpm check:packages` checks every package under `packages/` and `apps/`: exports map
present with at least one entry, no wildcards, no `src` in keys, targets under
`./src/` (private) or `./dist/` (published), `"type": "module"`, name
`@drefyn/<dir>`, `lint` exactly `eslint --max-warnings 0 .` and `typecheck` exactly
`tsc -p tsconfig.json`, no published package depending on a private one, and nothing
depending on an app.

Across the whole tree it fails on any inline disable of either rule (including a
blanket `eslint-disable` and a `/* eslint ... */` config comment, escaped names
included), and on any `eslint.config.*` or `pnpm-workspace.yaml` below the root. Both
files change what the rules see for their folder. The fixtures under `test/fixtures`
are exempt.

It also reads the git index and the new files git would add, and fails on:

- a path segment that starts with `-`, which a tool can read as an option
- a symlink, file or directory, outside `node_modules`: the rules and the guard see
  the link, not what it points to
- a submodule, since nothing inside one is linted
- a file under `packages/` or `apps/` with no extension or one outside source, JSON,
  CSS, Markdown, text, images and fonts, since Node can load it as code

It needs a git repository and fails without one.

It refuses a `pnpm-workspace.yaml` it cannot read, or one with no packages list,
rather than finding no packages and passing.

## Guard step

`pnpm lint:guard` (and the gate) lints every tracked or new source file once from the
root with `guard.config.js`, which holds only the two rules. It runs with
`--no-config-lookup`, `--no-inline-config` and `--no-ignore`, ends the options with
`--` so no file name is read as one, and pins the workspace root to the git top level
so a nested `pnpm-workspace.yaml` cannot move it. So a package script, a nested config,
a config comment, an ignore pattern, a force added `dist/` file or an option shaped
file name cannot switch the rules off for the files it lists. It fails if git fails or
lists no source files. It needs no type information and takes about a second. Per
package lint still runs the same rules with the full rule set, for the editor.

What it lists is files with a source extension; the manifest checker's rules on
symlinks, submodules and file types under `packages/` and `apps/` cover what Node
could load that the guard would not list. The guard trusts `guard.sh`,
`guard.config.js`, `scripts/gate.sh` and the CI workflow. A change to any of them, like
any change under `scripts/`, needs security review; the tests run the guard on a copy
of the real tree to catch an edit that only skips the real layout, but review is what
stops a deliberate one.

## Testing

```sh
pnpm --filter @drefyn/lint-rules test
```

Fixture workspaces in `test/fixtures` have their own `pnpm-workspace.yaml`, so the
rules see them as separate repos. Root lint and tsc skip them.
