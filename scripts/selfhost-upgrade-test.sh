#!/usr/bin/env bash
# Proves a volume made before drefyn_auth existed gets the role through the upgrade, and that
# its password never reaches the server log or pg_stat_statements on the way. The volume is
# made by the stack as it shipped at DREFYN_UPGRADE_FROM, a commit before the role, with every
# statement logged and pg_stat_statements loaded for the whole server, so a leak has every
# chance to show. Then the current files replace the old ones in the same checkout, as a
# git pull would, and the upgrade runs twice. A role made with other attributes is refused.
# Everything runs in a throwaway project from a scratch checkout; the real deploy/.env is
# never read or written.
set -euo pipefail

src="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The last development commit whose bootstrap had no drefyn_auth.
from="${DREFYN_UPGRADE_FROM:-5dfd92e2593f73c8b0ada38d1e2c8530804e2932}"
project="${DREFYN_UPGRADE_TEST_PROJECT:-drefyn-upgrade-test-$$}"
if [ "$project" = drefyn ]; then
  echo "upgrade test: refusing to run in project drefyn" >&2
  exit 64
fi
export COMPOSE_PROJECT_NAME="$project"
export DREFYN_POSTGRES_PORT="${DREFYN_UPGRADE_TEST_PORT:-55437}"
export DREFYN_SELFHOST_WAIT_SECONDS="${DREFYN_UPGRADE_TEST_WAIT_SECONDS:-90}"
# Passwords come from the deploy/.env the old up writes, never from the caller's shell.
unset DREFYN_STACK_ID DREFYN_POSTGRES_PASSWORD DREFYN_OWNER_PASSWORD DREFYN_APP_PASSWORD \
  DREFYN_PUBLIC_READER_PASSWORD DREFYN_AUTH_PASSWORD
scratch="$(mktemp -d)"
root="$scratch/checkout"
mkdir -p "$root"
compose=(docker compose -p "$project" -f "$root/deploy/compose.yaml")

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}
cleanup() {
  if [ "$failures" -gt 0 ] && [ -f "$root/deploy/compose.yaml" ]; then
    printf '      server log, last 60 lines:\n'
    "${compose[@]}" logs --no-color --tail 60 postgres 2>&1 | sed 's/^/        /' || true
  fi
  "${compose[@]}" down --volumes --timeout 5 >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT

# Every statement is logged by the server and pg_stat_statements keeps utility statements,
# so only the session settings the scripts choose stand between a password and the log.
loud_command='    command: [postgres, -c, hba_file=/etc/drefyn/pg_hba.conf, -c, shared_preload_libraries=pg_stat_statements, -c, log_statement=all, -c, log_min_duration_statement=0]'
make_loud() {
  local file="$root/deploy/compose.yaml"
  awk -v line="$loud_command" \
    '$0 == "    command: [postgres, -c, hba_file=/etc/drefyn/pg_hba.conf]" { print line; next } { print }' \
    "$file" >"$file.loud"
  mv "$file.loud" "$file"
  if ! grep -qF "$loud_command" "$file"; then
    echo "upgrade test: could not turn on server logging in $file" >&2
    exit 1
  fi
}

if ! git -C "$src" archive "$from" deploy scripts | tar -x -C "$root"; then
  echo "upgrade test: commit $from is not in this clone; fetch it first" >&2
  exit 1
fi
if grep -q drefyn_auth "$root/deploy/postgres/bootstrap.sql"; then
  echo "upgrade test: the bootstrap at $from already creates drefyn_auth" >&2
  exit 1
fi
make_loud

superuser_sql() {
  "${compose[@]}" exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -qtA -F '|' \
    --username postgres --dbname "${1:-drefyn}"
}
env_value() { sed -n "s/^$1=//p" "$root/deploy/.env"; }

if out="$(bash "$root/scripts/selfhost.sh" up 2>&1)"; then
  pass "the stack at $from comes up on an empty volume"
else
  fail "the stack at $from comes up on an empty volume" "$out"
  exit 1
fi
# Data that must survive the upgrade.
superuser_sql <<'SQL' >/dev/null
create table app.upgrade_probe (note text);
insert into app.upgrade_probe values ('kept');
create extension pg_stat_statements schema public;
SQL
roles="$(superuser_sql <<<"select string_agg(rolname, ',' order by rolname) from pg_roles where rolname like 'drefyn%';")"
if [ "$roles" = "drefyn_app,drefyn_owner,drefyn_public_reader" ] && [ -z "$(env_value DREFYN_AUTH_PASSWORD)" ]; then
  pass "the old volume has three roles and the old deploy/.env no auth password"
else
  fail "the old volume has three roles and the old deploy/.env no auth password" "roles [$roles]"
fi

# The current files, in the same place, as a pull would leave them. Copied over the old ones
# rather than after removing them: Docker Desktop cannot remount a bind mounted file whose
# folder was deleted under it.
cp -R "$src/scripts/." "$root/scripts/"
cp -R "$src/deploy/postgres/." "$root/deploy/postgres/"
cp "$src/deploy/compose.yaml" "$src/deploy/.env.example" "$src/deploy/README.md" "$root/deploy/"
make_loud

# up alone cannot help: the role is missing, so it fails and names the one command.
if out="$(DREFYN_SELFHOST_WAIT_SECONDS=20 bash "$root/scripts/selfhost.sh" up 2>&1)"; then
  fail "up on the old volume fails until the upgrade runs" "it succeeded: $out"
elif [[ "$out" == *"drefyn_auth"* ]] && [[ "$out" == *"scripts/selfhost.sh upgrade"* ]]; then
  pass "up on the old volume fails, naming drefyn_auth and the upgrade command"
else
  fail "up on the old volume fails, naming drefyn_auth and the upgrade command" "$out"
fi
auth_password="$(env_value DREFYN_AUTH_PASSWORD)"
if [ "${#auth_password}" = 48 ]; then
  pass "up added a generated DREFYN_AUTH_PASSWORD to the existing deploy/.env"
else
  fail "up added a generated DREFYN_AUTH_PASSWORD to the existing deploy/.env" \
    "length ${#auth_password}"
fi
if [ -n "$(find "$root/deploy/.env" -prune -perm 600)" ]; then
  pass "deploy/.env is still mode 600"
else
  fail "deploy/.env is still mode 600" "$(ls -l "$root/deploy/.env")"
fi

auth_oid() { superuser_sql <<<"select coalesce((select oid::text from pg_roles where rolname = 'drefyn_auth'), 'none');"; }

for run in 1 2; do
  if out="$(bash "$root/scripts/selfhost.sh" upgrade 2>&1)"; then
    pass "upgrade run $run succeeds and the stack is healthy"
  else
    fail "upgrade run $run succeeds and the stack is healthy" "$out"
  fi
  if [ "$run" = 1 ]; then
    first_oid="$(auth_oid)"
    expected="created drefyn_auth"
  else
    expected="drefyn_auth already exists"
  fi
  if [[ "$out" == *"$expected"* ]]; then
    pass "upgrade run $run says: $expected"
  else
    fail "upgrade run $run says: $expected" "$out"
  fi
done
if [ "$(auth_oid)" = "$first_oid" ] && [ "$first_oid" != none ]; then
  pass "the second run left the role the first one made"
else
  fail "the second run left the role the first one made" "oid $first_oid, then $(auth_oid)"
fi

attributes="$(superuser_sql <<'SQL'
select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication,
  rolconfig is null, (select count(*) from pg_db_role_setting where setrole = r.oid),
  (select count(*) from pg_auth_members where member = r.oid),
  has_database_privilege(r.oid, 'drefyn', 'CONNECT')
from pg_roles r where rolname = 'drefyn_auth';
SQL
)"
if [ "$attributes" = "t|f|f|f|f|f|f|t|0|0|t" ]; then
  pass "drefyn_auth has exactly the listed attributes and CONNECT on drefyn"
else
  fail "drefyn_auth has exactly the listed attributes and CONNECT on drefyn" "$attributes"
fi
# shellcheck disable=SC2016
whoami="$("${compose[@]}" exec -T postgres sh -c \
  'PGPASSWORD="$(cat /run/secrets/drefyn_auth_password)" exec psql --no-psqlrc -qtA \
    --host 127.0.0.1 --username drefyn_auth --dbname drefyn -c "select current_user"' 2>&1 || true)"
if [ "$whoami" = drefyn_auth ]; then
  pass "drefyn_auth logs in over TCP with the generated password"
else
  fail "drefyn_auth logs in over TCP with the generated password" "$whoami"
fi
kept="$(superuser_sql <<<'select note from app.upgrade_probe;')"
if [ "$kept" = kept ]; then
  pass "the data on the old volume is still there"
else
  fail "the data on the old volume is still there" "[$kept]"
fi

# docker collects the log on its own schedule, so wait for a marker logged after the runs.
server_log_now() {
  local marker container log=""
  marker="upgrademarker$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  superuser_sql <<<"do \$\$ begin raise log '%', '$marker'; end \$\$;" >/dev/null
  container="$("${compose[@]}" ps -q postgres)"
  for _ in $(seq 1 20); do
    log="$(docker logs "$container" 2>&1)"
    if [[ "$log" == *"$marker"* ]]; then break; fi
    sleep 0.5
  done
  if [[ "$log" != *"$marker"* ]]; then return 1; fi
  printf '%s' "$log"
}
# The query texts come back to this script and are searched here, so the search itself never
# sends the password to the server.
pgss_texts() { superuser_sql <<<'select query from public.pg_stat_statements;'; }

# expect_no_leak <when> <password> <statement pattern>: the pattern is matched against the
# statements the server logged, not against psql's own output that init leaves in the log.
expect_no_leak() {
  local when="$1" secret="$2" pattern="$3" log texts statements
  if ! log="$(server_log_now)"; then
    fail "$when: the server log holds no password" "the marker never reached docker logs"
  elif grep -qF -- "$secret" <<<"$log"; then
    fail "$when: the server log holds no password" \
      "$(grep -cF -- "$secret" <<<"$log") line(s) hold it"
  elif statements="$(grep -E '(statement|STATEMENT|execute [^:]*):' <<<"$log" || true)" &&
    grep -qiE -- "$pattern" <<<"$statements"; then
    fail "$when: the server log holds no password clause" \
      "$(grep -iE -- "$pattern" <<<"$statements" | head -n 3)"
  else
    pass "$when: the server log holds neither the password nor a password clause"
  fi
  if ! texts="$(pgss_texts)"; then
    fail "$when: pg_stat_statements can be read" "$texts"
  elif grep -qF -- "$secret" <<<"$texts" || grep -qiE -- "$pattern" <<<"$texts"; then
    fail "$when: pg_stat_statements holds no password" "$(grep -iE -- "$pattern" <<<"$texts" | head -n 3)"
  else
    pass "$when: pg_stat_statements holds neither the password nor a password clause"
  fi
}
log_lines="$(server_log_now | grep -c 'statement:' || true)"
if [ "${log_lines:-0}" -gt 0 ]; then
  pass "the server really logs statements ($log_lines statement lines)"
else
  fail "the server really logs statements" "no statement: lines in the log"
fi
expect_no_leak "after two upgrades" "$auth_password" 'create role|alter role|password[[:space:]]+(:|E?'"'"')'

# The same create, from a session that asks for every kind of logging the preamble knows.
superuser_sql <<'SQL' >/dev/null
set log_statement = 'none';
set log_min_duration_statement = -1;
set pg_stat_statements.track_utility = off;
revoke connect on database drefyn from drefyn_auth;
drop role drefyn_auth;
SQL
hostile='-c log_statement=all -c log_min_error_statement=debug5 -c log_min_duration_statement=0'
hostile+=' -c log_min_duration_sample=0 -c log_transaction_sample_rate=1'
hostile+=' -c debug_print_parse=on -c debug_print_rewritten=on -c debug_print_plan=on'
hostile+=' -c pg_stat_statements.track_utility=on'
if out="$("${compose[@]}" exec -T -e PGOPTIONS="$hostile" postgres sh /etc/drefyn/upgrade/run.sh 2>&1)" &&
  [[ "$out" == *"created drefyn_auth"* ]]; then
  pass "the upgrade creates the role from a session with every log setting on"
else
  fail "the upgrade creates the role from a session with every log setting on" "$out"
fi
expect_no_leak "after a create with every log setting on" "$auth_password" \
  'create role drefyn_auth login|password[[:space:]]+(:|E?'"'"')'

# A role that exists with other attributes is refused, not skipped, and nothing is changed.
superuser_sql <<'SQL' >/dev/null
set log_statement = 'none';
set log_min_duration_statement = -1;
set pg_stat_statements.track_utility = off;
revoke connect on database drefyn from drefyn_auth;
drop role drefyn_auth;
create role drefyn_auth login bypassrls;
SQL
if out="$("${compose[@]}" exec -T postgres sh /etc/drefyn/upgrade/run.sh 2>&1)"; then
  fail "the upgrade refuses drefyn_auth with bypassrls" "it exited 0: $out"
elif [[ "$out" == *"drefyn_auth already exists with other attributes"* ]] &&
  [[ "$out" == *"bypassrls"* ]]; then
  pass "the upgrade refuses drefyn_auth with bypassrls and names the attribute"
else
  fail "the upgrade refuses drefyn_auth with bypassrls and names the attribute" "$out"
fi
left="$(superuser_sql <<<"select rolbypassrls, has_database_privilege('drefyn_auth', 'drefyn', 'CONNECT') from pg_roles where rolname = 'drefyn_auth';")"
if [ "$left" = "t|f" ]; then
  pass "the refused upgrade changed nothing: still bypassrls, still no CONNECT"
else
  fail "the refused upgrade changed nothing: still bypassrls, still no CONNECT" "$left"
fi
superuser_sql <<<'drop role drefyn_auth;' >/dev/null

# Run by hand, as on managed Postgres, the file names a missing or short password and stops
# before create role.
upgrade_file() {
  "${compose[@]}" exec -T "$@" postgres psql --no-psqlrc --username postgres --dbname drefyn \
    --file /etc/drefyn/upgrade/0001-auth-role.sql 2>&1
}
if out="$(upgrade_file)"; then
  fail "the upgrade stops without DREFYN_AUTH_PASSWORD" "it exited 0: $out"
elif [[ "$out" == *"set DREFYN_AUTH_PASSWORD"* ]]; then
  pass "the upgrade stops without DREFYN_AUTH_PASSWORD and says so"
else
  fail "the upgrade stops without DREFYN_AUTH_PASSWORD and says so" "$out"
fi
if out="$(upgrade_file -e DREFYN_AUTH_PASSWORD=short-password)"; then
  fail "the upgrade stops on a short password" "it exited 0: $out"
elif [[ "$out" == *"at least 16 characters"* ]]; then
  pass "the upgrade stops on a short password"
else
  fail "the upgrade stops on a short password" "$out"
fi
if out="$("${compose[@]}" exec -T -e DREFYN_AUTH_PASSWORD="$auth_password" postgres psql \
  --no-psqlrc --username postgres --dbname postgres --file /etc/drefyn/upgrade/0001-auth-role.sql 2>&1)"; then
  fail "the upgrade stops on a database the bootstrap never set up" "it exited 0: $out"
elif [[ "$out" == *"run deploy/postgres/bootstrap.sql first"* ]]; then
  pass "the upgrade stops on a database the bootstrap never set up"
else
  fail "the upgrade stops on a database the bootstrap never set up" "$out"
fi
missing="$(auth_oid)"
if [ "$missing" = none ]; then
  pass "none of the stopped runs created the role"
else
  fail "none of the stopped runs created the role" "oid $missing"
fi

# A master user that may not quiet the log must stop before it reads the password.
master_password="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
if ! out="$("${compose[@]}" exec -T -e MASTER_PASSWORD="$master_password" postgres \
  psql --no-psqlrc -v ON_ERROR_STOP=1 -q --username postgres --dbname drefyn 2>&1 <<'SQL'
set log_statement = 'none';
set log_min_duration_statement = -1;
set pg_stat_statements.track_utility = off;
\getenv master_password MASTER_PASSWORD
create role upgrade_test_master login createrole password :'master_password';
grant pg_read_all_settings to upgrade_test_master;
grant connect on database drefyn to upgrade_test_master;
SQL
)"; then
  fail "a stand in master user can be created" "$out"
fi
if out="$("${compose[@]}" exec -T -e PGPASSWORD="$master_password" \
  -e DREFYN_AUTH_PASSWORD="$auth_password" postgres psql --no-psqlrc --host 127.0.0.1 \
  --username upgrade_test_master --dbname drefyn --file /etc/drefyn/upgrade/0001-auth-role.sql 2>&1)"; then
  fail "the upgrade stops for a role that cannot quiet the log" "it exited 0: $out"
elif [[ "$out" == *"DREFYN_BOOTSTRAP_LOG_CHECKED=yes"* ]] && [ "$(auth_oid)" = none ]; then
  pass "the upgrade stops for a role that cannot quiet the log, before create role"
else
  fail "the upgrade stops for a role that cannot quiet the log, before create role" "$out"
fi
expect_no_leak "after the stopped runs" "$auth_password" 'create role drefyn_auth login'

if out="$(bash "$root/scripts/selfhost.sh" upgrade 2>&1)" && [[ "$out" == *"created drefyn_auth"* ]]; then
  pass "the upgrade puts the role back and the stack is healthy"
else
  fail "the upgrade puts the role back and the stack is healthy" "$out"
fi

if [ "$failures" -gt 0 ]; then
  echo "upgrade test: $failures check(s) failed" >&2
  exit 1
fi
echo "upgrade test: passed"
