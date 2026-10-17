#!/usr/bin/env bash
# Proves the stack never reports healthy when its passwords are wrong: a short superuser
# password stops the first start, and a password in the environment that no longer matches
# the database makes restart fail with the role named. Then follows the documented way to
# change a password and checks the stack is healthy again. Runs its own throwaway project.
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

secret() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
# Values in the shell win over deploy/.env, so the test never edits the real file.
export DREFYN_POSTGRES_PASSWORD DREFYN_OWNER_PASSWORD DREFYN_APP_PASSWORD \
  DREFYN_PUBLIC_READER_PASSWORD
DREFYN_OWNER_PASSWORD="$(secret)"
DREFYN_APP_PASSWORD="$(secret)"
DREFYN_PUBLIC_READER_PASSWORD="$(secret)"

# A short superuser password stops the first start.
DREFYN_POSTGRES_PASSWORD=short-superuser
if out="$(bash "$root/scripts/selfhost.sh" up 2>&1)"; then
  fail "a 15 character superuser password stops the first start" "up succeeded: $out"
else
  logs="$("${compose[@]}" logs --no-color postgres 2>&1 || true)"
  if [[ "$logs" == *"postgres_password must be at least 16 characters"* ]]; then
    pass "a 15 character superuser password stops the first start"
  else
    fail "a 15 character superuser password stops the first start" "no reason in the logs: $logs"
  fi
  if [[ "$out" == *"docker compose"*"logs postgres"* ]]; then
    pass "a failed start points at the postgres logs"
  else
    fail "a failed start points at the postgres logs" "$out"
  fi
fi
bash "$root/scripts/selfhost.sh" reset --yes >/dev/null 2>&1

DREFYN_POSTGRES_PASSWORD="$(secret)"
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
if [ "$failures" -gt 0 ]; then
  echo "password test: $failures check(s) failed" >&2
  exit 1
fi
echo "password test: passed"
