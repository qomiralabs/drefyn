#!/usr/bin/env bash
# Smoke check for the self host compose stack. Run it against a stack that is already up
# (scripts/selfhost.sh up). With --teardown it then removes the stack and its volume and
# proves nothing is left behind.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$root/deploy/compose.yaml"
compose=(docker compose -f "$compose_file")

teardown=false
for arg in "$@"; do
  case "$arg" in
    --teardown) teardown=true ;;
    *)
      echo "usage: $0 [--teardown]" >&2
      exit 64
      ;;
  esac
done

failures=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  if [ -n "${2:-}" ]; then printf '      %s\n' "$2"; fi
  failures=$((failures + 1))
}
finish() {
  if [ "$failures" -gt 0 ]; then
    echo "smoke: $failures check(s) failed" >&2
    exit 1
  fi
  echo "smoke: passed"
}

# Every check after this needs the compose file and a running stack, so stop early with one
# clear message instead of a page of follow on failures.
if [ ! -f "$compose_file" ]; then
  fail "compose file exists" "$compose_file not found"
  finish
fi
for tool in docker jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    fail "$tool is installed"
    finish
  fi
done

config="$("${compose[@]}" config --format json)"
project="$(jq -r '.name' <<<"$config")"

# Ports: anything published must be bound to loopback. An empty host_ip means all interfaces.
bad_ports="$(jq -r '
  .services | to_entries[] | .key as $svc | (.value.ports // [])[]
  | select((.host_ip // "") != "127.0.0.1")
  | "\($svc) \(.published // "?"):\(.target) on \(.host_ip // "all interfaces")"
' <<<"$config")"
if [ -z "$bad_ports" ]; then
  pass "published ports bind to 127.0.0.1 only"
else
  fail "published ports bind to 127.0.0.1 only" "$bad_ports"
fi

container="$("${compose[@]}" ps -q postgres 2>/dev/null || true)"
if [ -z "$container" ]; then
  fail "postgres container is running" "project $project has no postgres container; run scripts/selfhost.sh up"
  finish
fi
health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container")"
if [ "$health" = "healthy" ]; then
  pass "postgres is healthy"
else
  fail "postgres is healthy" "health is $health"
  finish
fi

user="$(docker inspect --format '{{.Config.User}}' "$container")"
if [ "$user" = "postgres" ]; then
  pass "container runs as the postgres user, not root"
else
  fail "container runs as the postgres user, not root" "user is '${user:-root}'"
fi

# Superuser queries go over the container's local socket. Output is unaligned, one row per line.
superuser_sql() {
  "${compose[@]}" exec -T postgres psql --no-psqlrc -v ON_ERROR_STOP=1 -qtA -F '|' \
    --username postgres --dbname drefyn
}

# Role connections go over TCP with the role's own password, so they also prove the
# password works and that TCP is not trust.
role_sql() {
  local role="$1" secret="$2"
  # Expanded by the shell inside the container, where the secret file lives.
  # shellcheck disable=SC2016
  "${compose[@]}" exec -T -e ROLE="$role" -e SECRET="$secret" postgres sh -c \
    'PGPASSWORD="$(cat "/run/secrets/$SECRET")" exec psql --no-psqlrc -v ON_ERROR_STOP=1 -qtA \
      --host 127.0.0.1 --username "$ROLE" --dbname drefyn'
}

expect_rows() {
  local name="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$name"
  else
    fail "$name" "expected [$expected], got [$actual]"
  fi
}

# Role attributes. Columns: name, super, bypassrls, createrole, createdb, inherit, login.
roles="$(superuser_sql <<'SQL'
select rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolcanlogin
from pg_roles
where rolname in ('drefyn_owner', 'drefyn_app', 'drefyn_public_reader')
order by rolname;
SQL
)"
expect_rows "roles exist with no superuser, bypassrls, createrole or createdb" \
  "drefyn_app|f|f|f|f|f|t
drefyn_owner|f|f|f|f|t|t
drefyn_public_reader|f|f|f|f|f|t" "$roles"

# The bootstrap superuser is the only role allowed to skip row level security.
bypass="$(superuser_sql <<'SQL'
select coalesce(string_agg(rolname, ',' order by rolname), '')
from pg_roles where (rolsuper or rolbypassrls) and rolname <> 'postgres';
SQL
)"
expect_rows "no role besides the bootstrap superuser bypasses row level security" "" "$bypass"

owner="$(superuser_sql <<<"select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'app';")"
expect_rows "schema app is owned by drefyn_owner" "drefyn_owner" "$owner"

# Owner dependencies cover every object type, so this catches a table, schema, function or
# type owned by a role that must never own anything.
owned="$(superuser_sql <<'SQL'
select coalesce(string_agg(distinct r.rolname, ',' order by r.rolname), '')
from pg_shdepend d join pg_roles r on r.oid = d.refobjid
where d.deptype = 'o' and r.rolname in ('drefyn_app', 'drefyn_public_reader');
SQL
)"
expect_rows "app and public reader roles own nothing" "" "$owned"

public_schema="$(superuser_sql <<'SQL'
select r, has_schema_privilege(r, 'public', 'USAGE'), has_schema_privilege(r, 'public', 'CREATE')
from unnest(array['drefyn_app', 'drefyn_public_reader']) as r order by r;
SQL
)"
expect_rows "app and public reader roles have no rights on schema public" \
  "drefyn_app|f|f
drefyn_public_reader|f|f" "$public_schema"

# CREATE EXTENSION is transactional, so the check leaves the database as it found it.
vector="$(superuser_sql <<'SQL'
begin;
create extension vector;
select extversion from pg_extension where extname = 'vector';
select '[1,0]'::vector <=> '[0,1]'::vector, '[1,2]'::vector <=> '[2,4]'::vector;
rollback;
SQL
)"
expect_rows "pgvector 0.8.2 loads and cosine distance is correct" "0.8.2
1|0" "$vector"

whoami="$(role_sql drefyn_app drefyn_app_password <<<'select current_user;' 2>&1 || true)"
expect_rows "drefyn_app logs in over TCP with its password" "drefyn_app" "$whoami"
whoami="$(role_sql drefyn_public_reader drefyn_public_reader_password <<<'select current_user;' 2>&1 || true)"
expect_rows "drefyn_public_reader logs in over TCP with its password" "drefyn_public_reader" "$whoami"

wrong="$("${compose[@]}" exec -T -e PGPASSWORD=not-the-password postgres \
  psql --no-psqlrc -qtA --host 127.0.0.1 --username drefyn_app --dbname drefyn -c 'select 1' 2>&1 || true)"
if [[ "$wrong" == *"password authentication failed"* ]]; then
  pass "a wrong password is refused over TCP"
else
  fail "a wrong password is refused over TCP" "$wrong"
fi

# Each statement must fail with a permission error, not succeed and not fail for another reason.
expect_denied() {
  local role="$1" secret="$2" statement="$3" message="$4" out
  if out="$(role_sql "$role" "$secret" <<<"$statement" 2>&1)"; then
    fail "$role cannot run: $statement" "it succeeded"
  elif [[ "$out" == *"$message"* ]]; then
    pass "$role cannot run: $statement"
  else
    fail "$role cannot run: $statement" "unexpected error: $out"
  fi
}
for pair in "drefyn_app drefyn_app_password" "drefyn_public_reader drefyn_public_reader_password"; do
  read -r role secret <<<"$pair"
  expect_denied "$role" "$secret" "create table app.smoke (id int);" "permission denied for schema app"
  expect_denied "$role" "$secret" "create table public.smoke (id int);" "permission denied for schema public"
  expect_denied "$role" "$secret" "create schema smoke;" "permission denied for database drefyn"
done

if [ "$teardown" = true ]; then
  "${compose[@]}" down --volumes --timeout 30 >/dev/null 2>&1
  left="$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
  if [ -z "$left" ]; then
    pass "down --volumes removes every container"
  else
    fail "down --volumes removes every container" "still present: $left"
  fi
  left="$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
  if [ -z "$left" ]; then
    pass "down --volumes removes the data volume"
  else
    fail "down --volumes removes the data volume" "still present: $left"
  fi
fi

finish
