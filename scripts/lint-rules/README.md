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
`node:tls`, `node:dgram`, `node:dns`, `node:dns/promises`, the `_http_*`, `_tls_*` and
`_stream_wrap` internals behind them, and `undici`, each with or without `node:`. It
catches them in imports, re-exports, `require()`, `module.require()`,
`process.getBuiltinModule()` and a require made by `createRequire()`. It also reports
any runtime use of the global `fetch` or `WebSocket`: bare, through `globalThis`,
`window`, `self` or `global` (chained or destructured), and when the only binding is
an ambient `declare`. Type only imports pass.

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
- an aliased require (`const r = require; r('http')`)
- computed or indirect global access: `globalThis[k]`, `Reflect.get(globalThis, 'fetch')`,
  `const g = globalThis; g.fetch()`, `(0, globalThis).fetch`
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

It refuses a `pnpm-workspace.yaml` it cannot read, or one with no packages list,
rather than finding no packages and passing.

## Guard step

`pnpm lint:guard` (and the gate) lints every tracked or new source file once from the
root with `guard.config.js`, which holds only the two rules. It runs with
`--no-config-lookup`, `--no-inline-config` and `--no-ignore`, so a package script, a
nested config, a config comment, an ignore pattern or a force added `dist/` file
cannot switch the rules off. It needs no type information and takes about a second.
Per package lint still runs the same rules with the full rule set, for the editor.

## Testing

```sh
pnpm --filter @drefyn/lint-rules test
```

Fixture workspaces in `test/fixtures` have their own `pnpm-workspace.yaml`, so the
rules see them as separate repos. Root lint and tsc skip them.
