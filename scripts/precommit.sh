#!/usr/bin/env bash
# Fast checks for every commit. The full gate runs before push.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" != "24" ]; then
  echo "precommit: Node 24 is required, found $(node -v). Run 'nvm use' first." >&2
  exit 1
fi
if [ ! -x node_modules/.bin/prettier ]; then
  echo "precommit: dependencies are missing. Run 'pnpm install' first." >&2
  exit 1
fi

# Formatting is checked on the staged blob, not the working tree, so a partly staged
# file is judged by what will actually be committed.
status=0
while IFS= read -r -d '' path; do
  if ! errors="$(git show ":$path" |
    node_modules/.bin/prettier --check --ignore-unknown --stdin-filepath "$path" 2>&1 >/dev/null)"; then
    [ -n "$errors" ] && printf '%s\n' "$errors" >&2
    echo "precommit: $path is not formatted as staged. Run 'pnpm format' and stage it again." >&2
    status=1
  fi
done < <(git diff --cached --name-only --diff-filter=ACMR -z)
if [ "$status" -ne 0 ]; then exit "$status"; fi

# Reads the index, so it checks exactly what is about to be committed.
node scripts/hygiene/src/cli.ts --files
