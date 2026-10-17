#!/usr/bin/env bash
# Lints every tracked or new source file once, from the repo root, with only the
# boundary rules. Per package lint can be narrowed by a package script, a nested
# eslint.config.*, an inline config comment or an ignore pattern; this pass reads none
# of those. Extra arguments go to ESLint (the tests ask for JSON output).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Separate commands, so set -e sees a git failure; inside $(...) as an argument or a
# process substitution it would be lost and the guard would lint nothing and pass.
top="$(git rev-parse --show-toplevel)"
cd "$top"
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
# Fixture workspaces hold broken imports on purpose; their tests lint them.
git ls-files -z --cached --others --exclude-standard -- \
  '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' \
  ':!:scripts/lint-rules/test/fixtures/**' >"$list"

files=()
while IFS= read -r -d '' file; do
  # A tracked file deleted locally but not staged would make ESLint stop with no
  # result; CI checks out a clean tree, so skipping it only affects local runs.
  if [ -e "$file" ]; then files+=("$file"); fi
done <"$list"
if [ "${#files[@]}" -eq 0 ]; then
  echo "guard: no source files found" >&2
  exit 2
fi

# One ESLint run, not xargs: GNU xargs reports any failure as 123, which hides whether
# ESLint found problems (1) or crashed (2). If the tree ever outgrows the argument
# limit, exec fails with E2BIG and the step fails closed. The -- stops a file named
# like an option (a root file called --config=x.js) from being read as one.
exec "$here/../../node_modules/.bin/eslint" \
  --no-config-lookup --config "$here/guard.config.js" \
  --no-inline-config --no-ignore --max-warnings 0 "$@" -- "${files[@]}"
