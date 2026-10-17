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

A `require`, `module.require` or `createRequire` require with a literal relative
specifier is reported when the file Node resolves it to has no extension, or one other
than a source extension or `.json`: Node runs it as JavaScript, and nothing lints it.
The rule resolves the path the way Node does, so `./lib.v2` that finds `lib.v2.js`, a
folder that finds its `index.js` and a missing file pass, while `./net`, `./.tls` and a
folder whose `package.json` `main` names a `.txt` are reported. ESM imports of assets
such as CSS are left alone for bundlers.

The exemption belongs to the `@drefyn/egress` package at `packages/egress`, decided by
the owning manifest, not by the path. Other exceptions go in
`src/egress-allow-list.ts`, each with a `path` relative to the repo root (a trailing
`/` covers a directory) and a `reason`. The config fails to load if either is missing.
Every new entry needs a security review.

ESLint reads manifests once per process. Restart an editor's ESLint server after
changing a `package.json` or `pnpm-workspace.yaml`.

## Manifest checker

`pnpm check:packages` checks every package under `packages/` and `apps/`: exports map
present with at least one entry, no wildcards, no `src` in keys, targets under
`./src/` (private) or `./dist/` (published), `"type": "module"`, name
`@drefyn/<dir>`, `lint` exactly `eslint --max-warnings 0 .` and `typecheck` exactly
`tsc -p tsconfig.json`, no published package depending on a private one, and nothing
depending on an app.

It also reads the tree (the git index plus the new files git would add) and fails on
the entries listed under I1, I3, I4, I5, I11 and I12 below. It needs a git repository
and fails without one. The allowed file types are `ALLOWED_EXTENSIONS` in
`src/manifest.ts`, and the reviewed set is `REVIEWED_PREFIXES` and
`REVIEWED_ROOT_FILES` in the same file. Adding to either is a change under `scripts/`,
so it gets security review.

## Guard step

`pnpm lint:guard` (and the gate) lints every source file in the tree once from the
root with `guard.config.js`, which holds only the two rules. It runs with
`--no-config-lookup`, `--no-inline-config`, `--no-ignore` and `--max-warnings 0`, ends
the options with `--`, and pins the rules' workspace root to the git top level. It
needs no type information and takes about a second. Per package lint still runs the
same rules with the full rule set, for the editor.

## What the static checks enforce

The guard and the checker are built against honest mistakes and casual shortcuts: a
copied `fetch`, a deep import, a disable comment, a local config, a stray folder, or a
file name or layout trick a reviewer would not notice. They are not a sandbox. In
short, with the tree meaning every entry in `git ls-files -s` plus the new files git
would add, and the reviewed set meaning `scripts/`, `.github/`, `deploy/` and the root
files `.gitignore`, `.npmrc`, `.nvmrc`, `.prettierignore`, `LICENSE`,
`pnpm-lock.yaml` and `pnpm-workspace.yaml`:

- I1. Every tree entry outside the reviewed set has a source extension or one of
  `.json`, `.css`, `.md`, `.txt`, `.svg`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`,
  `.avif`, `.ico`, `.woff`, `.woff2`, `.ttf`, `.otf`. No extension (dotfiles included)
  is refused.
- I2. Every reviewed prefix and root file asks for security review and has a code
  owner.
- I3. No tree entry has a `node_modules` segment, in any case, anywhere.
- I4. No symlinks or submodules anywhere.
- I5. No path segment starts with `-`.
- I6. The guard lints every source file in the tree outside the fixtures.
- I7. Nothing in the tree (file content, file name, nested config, config or disable
  comment, ignore pattern, package script, nested workspace file) changes which rules
  the guard runs or which files they run on.
- I8. The guard and the checker fail closed: git failure, an empty list, a rule crash,
  no repository and an unreadable workspace file all fail the gate.
- I9. The rules catch the literal static forms listed under Rules above.
- I10. A require style load of a relative file is judged by the file Node resolves.
- I11. No disable or config comment names either rule, escapes decoded.
- I12. Every package has the exact lint and typecheck scripts, and no
  `eslint.config.*` or `pnpm-workspace.yaml` sits below the root outside the fixtures.
- I13. The manifest rules under Manifest checker above.
- I14. The template, the good fixtures and the current tree produce no reports, and
  every invariant has a named test.

## What the static checks do not catch

The checks read code; they do not run it. These are left to code review, security
review and the runtime controls (an egress worker role with no permissions and the
network policy):

- O1. Specifiers built at run time: computed or concatenated specifiers in `import()`,
  `require`, `createRequire` requires and `getBuiltinModule` (`import('node:' + x)`,
  templates with `${}`, `[].join`), a computed path to a non source file
  (`load(['.', 'x.txt'].join('/'))`), and `data:` or `blob:` URL imports.
- O2. Code as a string: `eval`, `new Function`, `Function.prototype.constructor`, the
  `vm` module, `new Worker(code, { eval: true })`.
- O3. Native and process level access: `process.binding('tcp_wrap')`,
  `internalBinding`, `process.dlopen`, native addons, `child_process` running `curl` or
  another binary.
- O4. Indirect access to globals and loaders: `Reflect.get(globalThis, 'fetch')`,
  `Reflect.apply`, `globalThis[k]`, `const g = globalThis; g.fetch()`,
  `const r = require; r('http')`, `let r; r = createRequire(...)`,
  `const { getBuiltinModule } = process`, `.call`, `.apply` and `.bind` forms
  (`require.call(null, 'http')`), `(0, globalThis).fetch`, and
  `const { ...rest } = globalThis; rest.fetch`.
- O5. Loader changes: `Module._extensions`, `require.extensions`, `Module._load`,
  `Module._resolveFilename`, `module.register` and other hooks, `--import`,
  `--loader`, `--require` and `NODE_OPTIONS`, including running an allowed non source
  file (such as `.json`) as code through any of them.
- O6. Third party packages that open sockets (`axios`, `ws`, `got`, `node-fetch`,
  `pg`), tracked in #31, and an `imports` map entry that points a `#` specifier at a
  builtin (`"#net": "net"`).
- O7. Network APIs not yet on the banned list, such as `EventSource`.
- O8. Anything that needs an edit to a security reviewed path: `guard.sh`,
  `guard.config.js`, `egress-allow-list.ts`, the rule and checker sources, `gate.sh`,
  any `eslint.config.*`, `rules.json`, CODEOWNERS, `.github/`, any `package.json`,
  `pnpm-workspace.yaml`, `.prettierignore`, `.gitattributes`, `.gitmodules`, the rest
  of the reviewed set and the allow list. The tests run the guard on a copy of the real
  tree to catch an edit that only skips the real layout, but security review is what
  stops a deliberate one.
- O9. Files outside the tree: ignored files, install and build outputs, real
  `node_modules` folders. What produces them (`package.json` scripts, `.pnpmfile.cjs`,
  the lockfile) is security reviewed.
- O10. Local only states a CI checkout cannot have: unstaged type changes, files
  deleted but not staged, untracked nested repositories, merge conflict stages.

## Testing

```sh
pnpm --filter @drefyn/lint-rules test
```

Fixture workspaces in `test/fixtures` have their own `pnpm-workspace.yaml`, so the
rules see them as separate repos. Root lint and tsc skip them.
