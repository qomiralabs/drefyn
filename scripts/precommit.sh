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

staged=()
while IFS= read -r -d '' path; do
  staged+=("$path")
done < <(git diff --cached --name-only --diff-filter=ACMR -z)

if [ "${#staged[@]}" -gt 0 ]; then
  node_modules/.bin/prettier --check --ignore-unknown -- "${staged[@]}"
fi

# Reads the index, so it checks exactly what is about to be committed.
node scripts/hygiene/src/cli.ts --files
