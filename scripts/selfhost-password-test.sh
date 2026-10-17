#!/usr/bin/env bash
# Proves the stack never reports healthy when its passwords are wrong, and never opens a
# superuser TCP login on the way: each bad first start stops, and the server the container
# restarts into still refuses the superuser and replication over TCP, even when init stopped
# before the bootstrap script ran. A password in the environment that no longer matches the
# database makes restart fail with the role named, and the documented way to change a
# password works. A harmless server warning never turns the stack unhealthy. The bootstrap
# refuses to run where it cannot keep passwords out of the server log. Runs its own
# throwaway project from a scratch copy of the checkout, so the real deploy/.env is untouched.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="${DREFYN_PASSWORD_TEST_PROJECT:-drefyn-password-test-$$}"
if [ "$project" = drefyn ]; then
  echo "password test: refusing to run in project drefyn" >&2
  exit 64
fi
export COMPOSE_PROJECT_NAME="$project"
export DREFYN_POSTGRES_PORT="${DREFYN_PASSWORD_TEST_PORT:-55438}"
# Failures are expected here, so do not wait the full first start budget for each one.
export DREFYN_SELFHOST_WAIT_SECONDS="${DREFYN_PASSWORD_TEST_WAIT_SECONDS:-25}"
scratch="$(mktemp -d)"
root="$scratch/checkout"
mkdir -p "$root"
cp -R "$src/scripts" "$src/deploy" "$root/"
rm -f "$root/deploy/.env"
compose=(docker compose -p "$project" -f "$root/deploy/compose.yaml")

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
  server_log
}
# Each case removes its stack straight away, so the server log only exists at the moment a
# check fails. It holds no passwords: the bootstrap keeps them out, which smoke proves.
server_log() {
  if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null)" ]; then
    printf '      server log, last 60 lines:\n'
    "${compose[@]}" logs --no-color --tail 60 postgres 2>&1 | sed 's/^/        /' || true
  fi
}

cleanup() {
  "${compose[@]}" down --volumes --timeout 5 >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

reset_stack() {
  local out
  if ! out="$("${compose[@]}" down --volumes --timeout 5 2>&1)"; then
    fail "the stack is removed between cases" "$out"
  fi
}

secret() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }
# Values in the shell win over deploy/.env.
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

# bad_start <case name> <expected log line> <expected text in up's output> [listens]
# up must fail, say why, and leave the superuser closed. The advice comes from the server log,
# not the healthcheck, because compose may give up before the healthcheck ever runs. Pass "silent" as the last argument
# when the server never starts listening, so there is nothing to probe.
bad_start() {
  local case_name="$1" expected="$2" advice="$3" listens="${4:-listens}" out logs
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
    # The reason line must say something after the colon.
    if grep -Eq 'not healthy after [0-9]+s: *$' <<<"$out"; then
      fail "after $case_name, up gives a reason" "$out"
    elif [[ "$out" == *"$advice"* ]]; then
      pass "after $case_name, up gives a reason and says what to do"
    else
      fail "after $case_name, up gives a reason and says what to do" "no [$advice] in: $out"
    fi
  fi
  if [ "$listens" = listens ]; then
    expect_superuser_closed "$case_name" "$DREFYN_POSTGRES_PASSWORD"
  fi
  reset_stack
}

DREFYN_OWNER_PASSWORD="$(secret)"
DREFYN_APP_PASSWORD="$(secret)"
DREFYN_PUBLIC_READER_PASSWORD="$(secret)"

DREFYN_POSTGRES_PASSWORD=""
bad_start "an empty superuser password" "superuser password is not specified" \
  "fix deploy/.env first" silent

DREFYN_POSTGRES_PASSWORD=short-superuser
bad_start "a 15 character superuser password" "postgres_password must be at least 16 characters" \
  "fix deploy/.env first"

DREFYN_POSTGRES_PASSWORD="$good_superuser"
DREFYN_OWNER_PASSWORD=""
bad_start "an empty owner password" "secret drefyn_owner_password is missing or empty" \
  "fix deploy/.env first"

DREFYN_OWNER_PASSWORD="$(secret)"
DREFYN_APP_PASSWORD=short-app
bad_start "a short app password" "each role password must be at least 16 characters" \
  "fix deploy/.env first"
DREFYN_APP_PASSWORD="$(secret)"

# Compose has returned success from up --wait at the timeout while the container was still
# restarting after a failed init, so the scripts must read health from docker themselves. This
# shim runs the real up without waiting and always reports success.
real_docker="$(command -v docker)"
mkdir -p "$scratch/shim"
cat >"$scratch/shim/docker" <<SHIM
#!/usr/bin/env bash
if [ "\$1" = compose ]; then
  args=()
  skip=false
  up=false
  for arg in "\$@"; do
    if [ "\$skip" = true ]; then skip=false; continue; fi
    case "\$arg" in
      --wait) continue ;;
      --wait-timeout) skip=true; continue ;;
      up) up=true ;;
    esac
    args+=("\$arg")
  done
  if [ "\$up" = true ]; then
    "$real_docker" "\${args[@]}" >/dev/null 2>&1
    exit 0
  fi
fi
exec "$real_docker" "\$@"
SHIM
chmod +x "$scratch/shim/docker"
DREFYN_OWNER_PASSWORD=""
if out="$(PATH="$scratch/shim:$PATH" bash "$root/scripts/selfhost.sh" up 2>&1)"; then
  fail "up fails when compose reports success but postgres is not healthy" "it exited 0: $out"
elif [[ "$out" == *"not healthy"* ]]; then
  pass "up fails when compose reports success but postgres is not healthy"
else
  fail "up fails when compose reports success but postgres is not healthy" "$out"
fi
reset_stack
DREFYN_OWNER_PASSWORD="$(secret)"

# Init can also stop before the bootstrap script runs at all: a crash, an out of memory kill, or
# here an init script that fails first. The server the container restarts into must still
# refuse the superuser over TCP, so that refusal cannot depend on init finishing.
mkdir -p "$scratch/initdb"
printf '#!/bin/sh\necho "password test: stopping init before the bootstrap" >&2\nexit 1\n' \
  >"$scratch/initdb/05-stop.sh"
cp "$root/deploy/postgres/initdb/10-bootstrap.sh" "$scratch/initdb/"
cat >"$scratch/override.yaml" <<YAML
services:
  postgres:
    volumes:
      - $scratch/initdb:/docker-entrypoint-initdb.d:ro
YAML
if out="$(docker compose -p "$project" -f "$root/deploy/compose.yaml" -f "$scratch/override.yaml" \
  up -d 2>&1)"; then
  expect_superuser_closed "init stopping before the bootstrap script" "$DREFYN_POSTGRES_PASSWORD"
else
  fail "a stack whose init stops early still starts a container" "$out"
fi
reset_stack

if out="$(bash "$root/scripts/selfhost.sh" up 2>&1)"; then
  pass "the stack comes up with good passwords"
else
  fail "the stack comes up with good passwords" "$out"
fi

superuser_sql() {
  "${compose[@]}" exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -q --username postgres "$@"
}

# A server warning at connect time, here a collation version mismatch as a new base image
# brings, must not make a healthy stack unhealthy or advise deleting it.
if ! out="$(superuser_sql --dbname postgres -c \
  "update pg_database set datcollversion = '0.1' where datname = 'drefyn'" 2>&1)"; then
  fail "the test can force a collation version mismatch" "$out"
fi
warning="$(superuser_sql --dbname drefyn -c 'select 1' 2>&1 >/dev/null || true)"
if [[ "$warning" == *"collation version mismatch"* ]]; then
  pass "a forced collation mismatch makes the server warn at connect"
else
  fail "a forced collation mismatch makes the server warn at connect" "$warning"
fi
if out="$("${compose[@]}" exec -T postgres sh /etc/drefyn/healthcheck.sh 2>&1)"; then
  pass "the healthcheck passes despite the warning"
else
  fail "the healthcheck passes despite the warning" "$out"
fi
if out="$(bash "$root/scripts/selfhost.sh" restart 2>&1)"; then
  pass "restart is healthy despite the warning"
elif [[ "$out" == *"reset --yes"* ]]; then
  fail "restart is healthy despite the warning" "it advised reset: $out"
else
  fail "restart is healthy despite the warning" "$out"
fi
if ! out="$(superuser_sql --dbname drefyn -c 'alter database drefyn refresh collation version' 2>&1)"; then
  fail "the collation version can be refreshed again" "$out"
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

# A managed database's master user cannot change log settings for its session but can read
# them. Stand one in: a role without the SET privilege, with pg_read_all_settings, and log
# settings applied to its logins. The bootstrap must stop before the first statement that
# carries a password unless the server already logs nothing, or the operator opts in.
master_password="$(secret)"
if ! out="$("${compose[@]}" exec -T -e MASTER_PASSWORD="$master_password" postgres \
  psql --no-psqlrc -v ON_ERROR_STOP=1 -q --username postgres --dbname drefyn 2>&1 <<'SQL'
set log_statement = 'none';
\getenv master_password MASTER_PASSWORD
create role password_test_master login createrole password :'master_password';
grant pg_read_all_settings to password_test_master;
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
set_master() {
  superuser_sql --dbname drefyn -c "alter role password_test_master set $1" >/dev/null
}
# expect_bootstrap_stops <why>: no opt in, so the bootstrap must refuse.
expect_bootstrap_stops() {
  local out
  if out="$(run_as_master)"; then
    fail "the bootstrap stops when $1" "it exited 0: $out"
  elif [[ "$out" == *"DREFYN_BOOTSTRAP_LOG_CHECKED=yes"* ]]; then
    pass "the bootstrap stops when $1"
  else
    fail "the bootstrap stops when $1" "$out"
  fi
}
expect_bootstrap_stops "statements are logged"
set_master "log_statement = 'none'"
expect_bootstrap_stops "a failed statement would be logged"

# docker collects the log on its own schedule, so wait for a marker logged after the runs.
marker="pwtestmarker$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
superuser_sql --dbname drefyn -c "do \$\$ begin raise log '%', '$marker'; end \$\$" >/dev/null
container="$("${compose[@]}" ps -q postgres)"
server_log=""
for _ in $(seq 1 20); do
  server_log="$(docker logs "$container" 2>&1)"
  if [[ "$server_log" == *"$marker"* ]]; then break; fi
  sleep 0.5
done
if [[ "$server_log" != *"$marker"* ]]; then
  fail "the stopped bootstrap logged no password" "marker $marker did not reach docker logs"
elif [[ "$server_log" == *"$canary"* ]]; then
  fail "the stopped bootstrap logged no password" "the canary is in docker logs"
else
  pass "the stopped bootstrap logged no password"
fi

# A server that logs nothing, failed statements included, needs no opt in. The next check then
# refuses because the bootstrap already ran.
set_master "log_min_error_statement = 'panic'"
out="$(run_as_master || true)"
if [[ "$out" == *"the bootstrap has already run"* ]]; then
  pass "the bootstrap carries on without an opt in when nothing is logged"
else
  fail "the bootstrap carries on without an opt in when nothing is logged" "$out"
fi
set_master "log_statement = 'all'"
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
