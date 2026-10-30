#!/usr/bin/env bash
# Measures the sign in rate limit upsert with pgbench, as drefyn_auth, inside the compose
# Postgres, and prints p50, p99 and max latency. Needs a running stack (scripts/selfhost.sh
# up) and COMPOSE_PROJECT_NAME. It creates and drops its own database.
#   bash scripts/bench-rate-limit.sh [clients] [seconds]
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
clients="${1:-4}"
seconds="${2:-20}"
if [ -z "${COMPOSE_PROJECT_NAME:-}" ]; then
  echo "bench: set COMPOSE_PROJECT_NAME to the stack to measure" >&2
  exit 64
fi
db="drefyn_bench_rate_limit"
compose=(docker compose -f deploy/compose.yaml)
psql_admin() {
  "${compose[@]}" exec -T postgres psql --no-psqlrc -q -v ON_ERROR_STOP=1 -U postgres -d postgres
}
owner="$(grep '^DREFYN_OWNER_PASSWORD=' deploy/.env | cut -d= -f2)"
auth="$(grep '^DREFYN_AUTH_PASSWORD=' deploy/.env | cut -d= -f2)"
port="${DREFYN_POSTGRES_PORT:-$(grep '^DREFYN_POSTGRES_PORT=' deploy/.env | cut -d= -f2)}"

cleanup() { psql_admin <<<"drop database if exists $db with (force);" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql_admin <<SQL
drop database if exists $db with (force);
create database $db template drefyn;
update pg_database set datacl = (select datacl from pg_database where datname = 'drefyn') where datname = '$db';
alter database $db set search_path = app, extensions;
SQL
DREFYN_DATABASE_SSL=disable \
  DREFYN_MIGRATION_DATABASE_URL="postgres://drefyn_owner:${owner}@127.0.0.1:${port}/${db}" \
  node packages/db/src/cli.ts migrate up >/dev/null

"${compose[@]}" exec -T postgres sh -c 'rm -f /tmp/bench_rl*; cat > /tmp/bench_rl.sql' \
  <packages/db/bench/rate-limit-upsert.sql
"${compose[@]}" exec -T -e PGPASSWORD="$auth" postgres \
  pgbench -h 127.0.0.1 -U drefyn_auth -d "$db" -n -M prepared -c "$clients" -j "$clients" \
  -T "$seconds" -f /tmp/bench_rl.sql -l --log-prefix=/tmp/bench_rl_log | grep -E 'tps|latency|transactions actually'
# Column 3 of the per transaction log is the latency in microseconds.
"${compose[@]}" exec -T postgres sh -c 'cat /tmp/bench_rl_log*' |
  awk '{print $3}' | sort -n |
  awk '{v[NR]=$1} END {
    printf "samples %d\n", NR
    printf "p50 %.3f ms\n", v[int(NR*0.50)] / 1000
    printf "p99 %.3f ms\n", v[int(NR*0.99)] / 1000
    printf "max %.3f ms\n", v[NR] / 1000
  }'
