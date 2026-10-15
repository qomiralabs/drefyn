#!/usr/bin/env bash
# Full local gate. CI runs this same script, so green here should mean green there.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export TURBO_TELEMETRY_DISABLED=1

in_ci=false
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then in_ci=true; fi

step() {
  if [ "$in_ci" = true ]; then
    echo "::endgroup::"
    echo "::group::$1"
  else
    printf '\n==> %s\n' "$1"
  fi
}

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" != "24" ]; then
  echo "gate: Node 24 is required, found $(node -v). Run 'nvm use' first." >&2
  exit 1
fi

step "install (frozen lockfile)"
pnpm install --frozen-lockfile

step "format"
pnpm exec turbo run format:check

step "lint"
pnpm exec turbo run lint lint:root

step "typecheck"
pnpm exec turbo run typecheck typecheck:root

step "test with coverage"
pnpm exec turbo run test

step "hygiene"
node scripts/hygiene/src/cli.ts --files

step "secrets"
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --redact --no-banner .
elif [ "$in_ci" = true ]; then
  # The security workflow runs a pinned, checksummed gitleaks on every push.
  echo "gitleaks runs in the security workflow"
else
  echo "gitleaks is not installed; skipped here, CI still runs it"
fi

if [ "$in_ci" = true ]; then echo "::endgroup::"; fi
echo "gate: passed"
