#!/usr/bin/env bash
# Full local gate. CI runs this same script, so green here should mean green there.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export TURBO_TELEMETRY_DISABLED=1

in_ci=false
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then in_ci=true; fi

group_open=false
step() {
  if [ "$in_ci" = true ]; then
    if [ "$group_open" = true ]; then echo "::endgroup::"; fi
    echo "::group::$1"
    group_open=true
  else
    printf '\n==> %s\n' "$1"
  fi
}

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" != "24" ]; then
  echo "gate: Node 24 is required, found $(node -v). Run 'nvm use' first." >&2
  exit 1
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

step "install (frozen lockfile)"
pnpm install --frozen-lockfile

step "format"
pnpm exec turbo run format:check

step "lint"
pnpm exec turbo run lint lint:root

step "boundary guard"
bash scripts/lint-rules/guard.sh

step "package manifests"
pnpm check:packages

step "typecheck"
pnpm exec turbo run typecheck typecheck:root

step "test with coverage"
pnpm exec turbo run test

step "licenses"
pnpm licenses list --json > "$scratch/licenses.json"
# The production listing proves dev only exceptions stay out of what ships; the lockfile
# covers platform binaries this machine never installed.
pnpm licenses list --prod --json > "$scratch/licenses-prod.json"
node scripts/license-policy/src/cli.ts --input "$scratch/licenses.json" \
  --prod-input "$scratch/licenses-prod.json" --lockfile pnpm-lock.yaml \
  --notices THIRD_PARTY_NOTICES.md

step "hygiene"
# Commit messages are checked against development when it is known locally; CI checks
# the exact PR range in the hygiene workflow.
if git rev-parse --verify --quiet origin/development >/dev/null; then
  node scripts/hygiene/src/cli.ts --files --commits origin/development..HEAD
else
  node scripts/hygiene/src/cli.ts --files
fi

step "secrets"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --redact --no-banner .
elif [ "$in_ci" = true ]; then
  # The security workflow runs a pinned, checksummed gitleaks on every push.
  echo "gitleaks runs in the security workflow"
else
  echo "gitleaks is not installed; skipped here, CI still runs it"
fi

if [ "$group_open" = true ]; then echo "::endgroup::"; fi
echo "gate: passed"
