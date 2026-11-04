#!/usr/bin/env bash
# Floods one rate limit key through the auth pool and prints what the hot key, the pool wait
# and unrelated sign ins see. Point DREFYN_AUTH_DATABASE_URL at a throwaway migrated database:
# the counters it writes stay until the expiry cleanup. Run it on a quiet machine.
#   bash scripts/bench-limiter-flood.sh [workers,workers,...] [seconds per run]
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
if [ -z "${DREFYN_AUTH_DATABASE_URL:-}" ]; then
  echo "bench: set DREFYN_AUTH_DATABASE_URL to a throwaway migrated database" >&2
  exit 64
fi
exec node packages/db/bench/limiter-flood.ts "$@"
