#!/usr/bin/env bash
# Lints every tracked or new source file once, from the repo root, with only the
# boundary rules. Per package lint can be narrowed by a package script, a nested
# eslint.config.*, an inline config comment or an ignore pattern; this pass reads none
# of those. Extra arguments go to ESLint (the tests ask for JSON output).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$(git rev-parse --show-toplevel)"

# Fixture workspaces hold broken imports on purpose; their tests lint them.
git ls-files -z --cached --others --exclude-standard -- \
  '*.ts' '*.tsx' '*.mts' '*.cts' '*.js' '*.jsx' '*.mjs' '*.cjs' \
  ':!:scripts/lint-rules/test/fixtures/**' |
  xargs -0 -r "$here/../../node_modules/.bin/eslint" \
    --no-config-lookup --config "$here/guard.config.js" \
    --no-inline-config --no-ignore --max-warnings 0 "$@"
