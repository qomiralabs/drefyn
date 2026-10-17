#!/usr/bin/env bash
# Proves the stack never reports healthy when its passwords are wrong, and never opens a
# superuser TCP login on the way: each bad first start stops, and the server the container
# restarts into still refuses the superuser and replication over TCP. A password in the
# environment that no longer matches the database makes restart fail with the role named,
# and the documented way to change a password works. The bootstrap refuses to run where it
# cannot keep passwords out of the server log. Runs its own throwaway project.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="${DREFYN_PASSWORD_TEST_PROJECT:-drefyn-password-test-$$}"
if [ "$project" = drefyn ]; then
  echo "password test: refusing to run in project drefyn" >&2
  exit 64
fi
export COMPOSE_PROJECT_NAME="$project"
export DREFYN_POSTGRES_PORT="${DREFYN_PASSWORD_TEST_PORT:-55438}"
# Failures are expected here, so do not wait the full first start budget for each one.
export DREFYN_SELFHOST_WAIT_SECONDS="${DREFYN_PASSWORD_TEST_WAIT_SECONDS:-25}"
compose=(docker compose -f "$root/deploy/compose.yaml")

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}

cleanup() {
  "${compose[@]}" down --volumes --timeout 5 >/dev/null 2>&1 || true
}
trap cleanup EXIT

reset_stack() {
  local out
  if ! out="$(bash "$root/scripts/selfhost.sh" reset --yes 2>&1)"; then
    fail "reset --yes removes the stack between cases" "$out"
  fi
}

secret() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
# Values in the shell win over deploy/.env, so the test never edits the real file.
export DREFYN_STACK_ID DREFYN_POSTGRES_PASSWORD DREFYN_OWNER_PASSWORD DREFYN_APP_PASSWORD \
  DREFYN_PUBLIC_READER_PASSWORD
DREFYN_STACK_ID="$(secret)"
good_superuser="$(secret)"

# tcp_probe <password> <psql connection string> <sql>: runs psql over TCP inside the
# container. Retries while the container restarts or the server starts, so the answer comes
# from the server the container settles into.
tcp_probe() {
  local out
  for _ in $(seq 1 40); do
    # Expanded by the shell inside the container.
    # shellcheck disable=SC2016
    out="$("${compose[@]}" exec -T -e PW="$1" -e CONN="$2" -e SQL="$3" postgres sh -c \
      'PGPASSWORD="$PW" exec psql --no-psqlrc -qtA "$CONN" -c "$SQL"' 2>&1 || true)"
    case "$out" in
      *"is not running"* | *"is restarting"* | *"No such container"* | *"Connection refused"* | \
        *"starting up"* | *"shutting down"* | *"not yet accepting"* | *"no such service"* | "")
        sleep 1
        ;;
      *) break ;;
    esac
  done
  printf '%s' "$out"
}

# After a failed first start, the superuser and replication stay closed over TCP, even with
# the password the container was given.
expect_superuser_closed() {
  local case_name="$1" password="$2" out
  out="$(tcp_probe "$password" "host=127.0.0.1 user=postgres dbname=drefyn" "select 1")"
  if [[ "$out" == *"pg_hba.conf rejects connection"* ]]; then
    pass "after $case_name, the superuser cannot log in over TCP"
  else
    fail "after $case_name, the superuser cannot log in over TCP" "$out"
  fi
  out="$(tcp_probe "$password" "host=127.0.0.1 user=postgres dbname=replication replication=true" \
    "IDENTIFY_SYSTEM")"
  if [[ "$out" == *"pg_hba.conf rejects replication connection"* ]]; then
    pass "after $case_name, physical replication is refused over TCP"
  else
    fail "after $case_name, physical replication is refused over TCP" "$out"
  fi
}

# bad_start <case name> <expected log line>: up must fail, say why in the logs, and leave
# the superuser closed.
bad_start() {
  local case_name="$1" expected="$2" out logs
  if out="$(bash "$root/scripts/selfhost.sh" up 2>&1)"; then
    fail "$case_name stops the first start" "up succeeded: $out"
  else
    logs="$("${compose[@]}" logs --no-color postgres 2>&1 || true)"
    if [[ "$logs" == *"$expected"* ]]; then
      pass "$case_name stops the first start"
    else
      fail "$case_name stops the first start" "no [$expected] in the logs: $logs"
    fi
    if [[ "$out" == *"docker compose"*"logs postgres"* ]]; then
      pass "after $case_name, up points at the postgres logs"
    else
      fail "after $case_name, up points at the postgres logs" "$out"
    fi
  fi
  expect_superuser_closed "$case_name" "$DREFYN_POSTGRES_PASSWORD"
  reset_stack
}

DREFYN_POSTGRES_PASSWORD=short-superuser
DREFYN_OWNER_PASSWORD="$(secret)"
DREFYN_APP_PASSWORD="$(secret)"
DREFYN_PUBLIC_READER_PASSWORD="$(secret)"
bad_start "a 15 character superuser password" "postgres_password must be at least 16 characters"

DREFYN_POSTGRES_PASSWORD="$good_superuser"
DREFYN_OWNER_PASSWORD=""
bad_start "an empty owner password" "secret drefyn_owner_password is missing or empty"

DREFYN_OWNER_PASSWORD="$(secret)"
DREFYN_APP_PASSWORD=short-app
bad_start "a short app password" "each role password must be at least 16 characters"

DREFYN_APP_PASSWORD="$(secret)"
if out="$(bash "$root/scripts/selfhost.sh" up 2>&1)"; then
  pass "the stack comes up with good passwords"
else
  fail "the stack comes up with good passwords" "$out"
fi

# Editing the password the stack reads, without changing the database, must not look healthy.
old_app_password="$DREFYN_APP_PASSWORD"
DREFYN_APP_PASSWORD="$(secret)"
if out="$(bash "$root/scripts/selfhost.sh" restart 2>&1)"; then
  fail "restart with a changed app password fails" "restart succeeded: $out"
elif [[ "$out" == *"drefyn_app cannot log in"* ]]; then
  pass "restart with a changed app password fails and names the role"
else
  fail "restart with a changed app password fails and names the role" "$out"
fi

# The documented change: set the new password as the superuser, then restart. The test sets
# it with ALTER ROLE because \password needs a terminal; logging is off for the session.
new_app_password="$DREFYN_APP_PASSWORD"
DREFYN_APP_PASSWORD="$old_app_password"
if ! out="$("${compose[@]}" exec -T -e NEW_PASSWORD="$new_app_password" postgres \
  psql --no-psqlrc -v ON_ERROR_STOP=1 -q --username postgres --dbname drefyn 2>&1 <<'SQL'
set log_statement = 'none';
set log_min_error_statement = 'panic';
\getenv new_password NEW_PASSWORD
alter role drefyn_app password :'new_password';
SQL
)"; then
  fail "the superuser can set a new app password over the socket" "$out"
fi
DREFYN_APP_PASSWORD="$new_app_password"
# Healthy means the healthcheck logged in as every role with the password it was given.
if out="$(bash "$root/scripts/selfhost.sh" restart 2>&1)"; then
  pass "after the documented change, restart is healthy again"
else
  fail "after the documented change, restart is healthy again" "$out"
fi

# A managed database's master user cannot turn off statement logging for its session. Stand
# one in: a role without the privilege, with log_statement = all for its logins. The bootstrap
# must stop before the first statement that carries a password, unless the operator opts in.
master_password="$(secret)"
if ! out="$("${compose[@]}" exec -T -e MASTER_PASSWORD="$master_password" postgres \
  psql --no-psqlrc -v ON_ERROR_STOP=1 -q --username postgres --dbname drefyn 2>&1 <<'SQL'
set log_statement = 'none';
\getenv master_password MASTER_PASSWORD
create role password_test_master login createrole password :'master_password';
alter role password_test_master set log_statement = 'all';
grant connect on database drefyn to password_test_master;
SQL
)"; then
  fail "a stand in master user can be created" "$out"
fi
canary="pwtestcanary$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
run_as_master() {
  "${compose[@]}" exec -T -e PGPASSWORD="$master_password" -e DREFYN_OWNER_PASSWORD="$canary" \
    -e DREFYN_APP_PASSWORD="$canary" -e DREFYN_PUBLIC_READER_PASSWORD="$canary" "$@" postgres \
    psql --no-psqlrc --host 127.0.0.1 --username password_test_master --dbname drefyn \
    --file /etc/drefyn/bootstrap.sql 2>&1
}
if out="$(run_as_master)"; then
  fail "the bootstrap stops when it cannot turn off statement logging" "it exited 0: $out"
elif [[ "$out" == *"DREFYN_BOOTSTRAP_LOG_CHECKED=yes"* ]]; then
  pass "the bootstrap stops when it cannot turn off statement logging"
else
  fail "the bootstrap stops when it cannot turn off statement logging" "$out"
fi
container="$("${compose[@]}" ps -q postgres)"
if docker logs "$container" 2>&1 | grep -q "$canary"; then
  fail "the stopped bootstrap logged no password" "the canary is in docker logs"
else
  pass "the stopped bootstrap logged no password"
fi
# Opting in carries on to the next check, which refuses because the bootstrap already ran.
out="$(run_as_master -e DREFYN_BOOTSTRAP_LOG_CHECKED=yes || true)"
if [[ "$out" == *"the bootstrap has already run"* ]]; then
  pass "DREFYN_BOOTSTRAP_LOG_CHECKED=yes lets the bootstrap carry on"
else
  fail "DREFYN_BOOTSTRAP_LOG_CHECKED=yes lets the bootstrap carry on" "$out"
fi

if [ "$failures" -gt 0 ]; then
  echo "password test: $failures check(s) failed" >&2
  exit 1
fi
echo "password test: passed"
