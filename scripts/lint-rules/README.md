# `@drefyn/lint-rules`

Repo tooling that keeps workspace packages behind their public entry points and keeps
outbound network calls behind `@drefyn/egress`. The root `eslint.config.js` loads the
rules for every package at severity `error`.

## Rules

`drefyn/no-cross-package-internals` resolves each import to the workspace package
that owns it, using `pnpm-workspace.yaml`, and reports:

- `internal`: a relative path into another package, such as `../x/src/internal.ts`.
- `unexported`: a bare `@drefyn/x/<sub>` that is not a key in x's `exports`.
- `undeclared`: a bare `@drefyn/x` missing from the importer's `dependencies` and
  `devDependencies`.

It checks static, type only and dynamic imports, re-exports, `import('x').T` types and
`require()`. Builtins, URLs, `#imports`, absolute paths and npm packages are left to
Node, tsc and the exports maps.

`drefyn/no-raw-egress` reports `node:http`, `node:https`, `node:http2`, `node:net`,
`node:tls`, `node:dgram`, `node:dns`, `node:dns/promises` and `undici` (with or
without `node:`), and any runtime use of the global `fetch` or `WebSocket`, outside
`packages/egress`. Type only imports pass. Exceptions go in `egressAllowList` in the
root `eslint.config.js`, each with a `path` relative to the repo root (a trailing `/`
covers a directory) and a `reason`. The config fails to load if either is missing.
Every new entry needs a security review.

ESLint reads manifests once per process. Restart an editor's ESLint server after
changing a `package.json`.

## Manifest checker

`pnpm check:packages` checks every package under `packages/` and `apps/`: exports map
present, no wildcards, no `src` in keys, targets under `./src/` (private) or `./dist/`
(published), `"type": "module"`, name `@drefyn/<dir>`, no published package depending
on a private one, and nothing depending on an app. It also fails on any inline
disable of either rule, including a blanket `eslint-disable`, anywhere in the repo.

## Testing

```sh
pnpm --filter @drefyn/lint-rules test
```

Fixture workspaces in `test/fixtures` have their own `pnpm-workspace.yaml`, so the
rules see them as separate repos. Root lint and tsc skip them.
